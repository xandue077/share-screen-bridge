(function () {
  "use strict";

  var API = (window.BOTPANEL_API || "").replace(/\/+$/, "");
  var BRIDGE = (window.BOTPANEL_BRIDGE_URL || "").replace(/\/+$/, "");
  var TOKEN_KEY = "botpanel.token";
  var LINK_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

  var state = {
    token: null,
    account: null,
    groups: [],
    guildId: "",
    channelId: "",
    mode: null,
    source: "youtube",
    results: [],
    selected: null,
    queue: [],
    busy: false,
    voiceQuery: "",
    voiceOpen: false,
    playing: false,
    playerPaused: false,
    seeking: false,
    statusTimer: null,
    volumeTimer: null,
  };

  var $ = function (id) {
    return document.getElementById(id);
  };

  function show(el) {
    el.classList.remove("hidden");
  }
  function hide(el) {
    el.classList.add("hidden");
  }

  function setText(el, text) {
    el.textContent = text;
  }

  function placeholderThumb(title) {
    var label = String(title || "video").replace(/[<>&"]/g, "").slice(0, 34);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
      '<rect width="320" height="180" fill="#131c33"/>' +
      '<circle cx="160" cy="76" r="28" fill="#1e2a45"/>' +
      '<path d="M151 62l22 14-22 14z" fill="#5b8cff"/>' +
      '<text x="160" y="138" fill="#94a3c4" font-family="sans-serif" font-size="14" text-anchor="middle">' +
      label +
      "</text></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function setThumb(img, src, title) {
    var fallback = placeholderThumb(title);
    img.onerror = function () {
      img.onerror = null;
      img.src = fallback;
    };
    img.src = src || fallback;
  }

  function api(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (state.token) headers["x-bot-token"] = state.token;
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
      cache: "no-store",
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return { ok: false, error: "Unexpected response from the API." };
        })
        .then(function (data) {
          return { status: res.status, data: data };
        });
    });
  }

  function directBridge(path, options) {
    var opts = options || {};
    return fetch(BRIDGE + path, {
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body,
      cache: "no-store",
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: false, error: "Unexpected response from the bridge." };
        }).then(function (data) {
          return { status: res.status, data: data };
        });
      });
  }

  function bridgeSearch(query) {
    return directBridge("/search?source=kisskh&q=" + encodeURIComponent(query))
      .then(function (result) {
        if (result.status !== 200 || !result.data.ok) {
          return { status: result.status, data: { ok: false, error: result.data.error || "Movie search failed." } };
        }
        return {
          status: 200,
          data: {
            ok: true,
            mode: "search",
            items: (result.data.items || []).map(function (item) {
              return {
                id: item.id || "",
                title: item.title,
                year: item.year || "",
                thumb: item.thumb || "",
                source: "kisskh",
                episodes: item.episodes || 0,
                channel: item.episodes > 1 ? item.episodes + " episodes" : item.year || "Movie",
                url: "https://kisskh.do/Search?q=" + encodeURIComponent(item.title),
              };
            }),
          },
        };
      });
  }

  function bridgeChannels() {
    return directBridge("/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.token }),
    }).then(function (result) {
      if (result.status !== 200 || !result.data.ok) {
        return {
          status: result.status,
          data: { ok: false, error: result.data.error || "Could not list voice channels." },
        };
      }
      return { status: 200, data: result.data };
    });
  }

  function bridgeLogin(token) {
    return directBridge("/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    }).then(function (result) {
      if (result.status !== 200 || !result.data.ok) {
        return {
          status: result.status,
          data: { ok: false, error: result.data.error || "Could not verify that token." },
        };
      }
      return {
        status: 200,
        data: { ok: true, account: result.data.account, groups: result.data.groups || [] },
      };
    });
  }

  function bridgePlay(payload) {
    return directBridge("/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({}, payload, { token: state.token, auth: "user" })),
    }).then(function (result) {
      if (result.status !== 200 || !result.data.ok) {
        return { status: result.status, data: { ok: false, error: result.data.error || "The bot refused the request." } };
      }
      return { status: 200, data: result.data };
    });
  }

  function bridgeStop() {
    if (!BRIDGE || !state.token) return;
    var token = state.token;
    directBridge("/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop", token: token }),
    }).catch(function () {});
  }

  function signedOut(message) {
    hidePlayer();
    state.token = null;
    state.account = null;
    state.groups = [];
    localStorage.removeItem(TOKEN_KEY);
    hide($("app"));
    hide($("boot"));
    show($("login"));
    if (message) {
      setText($("login-error"), message);
      show($("login-error"));
    }
    $("token").focus();
  }

  function signedIn(account) {
    state.account = account;
    hide($("boot"));
    hide($("login"));
    show($("app"));
    renderAccount();
    loadVoice();
    renderSelected();
    renderQueue();
  }

  function avatarUrl(account) {
    if (!account || !account.avatar) return null;
    var ext = account.avatar.indexOf("a_") === 0 ? "gif" : "png";
    return "https://cdn.discordapp.com/avatars/" + account.id + "/" + account.avatar + "." + ext + "?size=96";
  }

  function renderAccount() {
    var account = state.account;
    var name = account.globalName || account.username;
    setText($("me-name"), name);
    setText($("me-sub"), (account.isBot ? "Bot account" : "User account") + " · " + account.username);
    var src = avatarUrl(account);
    var img = $("me-avatar");
    var fallback = $("me-fallback");
    if (src) {
      img.src = src;
      img.alt = name;
      show(img);
      hide(fallback);
    } else {
      hide(img);
      show(fallback);
      setText(fallback, name.slice(0, 1).toUpperCase());
    }
  }

  function findVoice(guildId, channelId) {
    for (var i = 0; i < state.groups.length; i += 1) {
      var group = state.groups[i];
      if (group.id !== guildId) continue;
      for (var j = 0; j < group.channels.length; j += 1) {
        if (group.channels[j].id === channelId) return { group: group, channel: group.channels[j] };
      }
    }
    return null;
  }

  function voiceLabel(group, channel) {
    return group.name + " · " + channel.name;
  }

  function rememberVoice() {
    try {
      localStorage.setItem(
        "botpanel.voice.recent",
        JSON.stringify({ guildId: state.guildId, channelId: state.channelId }),
      );
    } catch (e) {
      /* localStorage may be unavailable */
    }
  }

  function restoreVoice() {
    var raw;
    try {
      raw = localStorage.getItem("botpanel.voice.recent");
    } catch (e) {
      return;
    }
    if (!raw) return;
    try {
      var recent = JSON.parse(raw);
      var found = findVoice(recent.guildId, recent.channelId);
      if (found && found.channel.type !== 13) {
        state.guildId = recent.guildId;
        state.channelId = recent.channelId;
      }
    } catch (e) {
      /* ignore malformed recent channel */
    }
  }

  function renderVoice(loading) {
    var current = findVoice(state.guildId, state.channelId);
    setText(
      $("voice-current"),
      loading
        ? "Loading voice channels…"
        : current
        ? voiceLabel(current.group, current.channel)
        : "No channel selected — pick one below."
    );

    var picker = $("voice-picker");
    var change = $("voice-change");
    if (loading) {
      hide(picker);
      change.disabled = true;
      setText($("voice-summary"), "Reading servers…");
      return;
    }

    change.disabled = false;
    setText(change, state.voiceOpen ? "Done" : "Change");
    if (state.voiceOpen) show(picker);
    else hide(picker);

    var total = state.groups.reduce(function (sum, group) {
      return sum + group.channels.length;
    }, 0);
    setText(
      $("voice-summary"),
      state.groups.length === 0
        ? ""
        : state.groups.length + " server" + (state.groups.length === 1 ? "" : "s") + " · " + total + " voice channel" + (total === 1 ? "" : "s")
    );
    if (state.groups.length === 0) show($("no-guilds"));
    else hide($("no-guilds"));

    var list = $("voice-list");
    list.innerHTML = "";
    var query = state.voiceQuery.trim().toLowerCase();
    var foundAny = false;

    state.groups.forEach(function (group) {
      var channels = group.channels.filter(function (channel) {
        return (
          !query ||
          group.name.toLowerCase().indexOf(query) >= 0 ||
          channel.name.toLowerCase().indexOf(query) >= 0
        );
      });
      if (channels.length === 0) return;
      foundAny = true;

      var heading = document.createElement("div");
      heading.className = "voice-group";
      heading.textContent = group.name;
      list.appendChild(heading);

      channels.forEach(function (channel) {
        var button = document.createElement("button");
        button.type = "button";
        button.className =
          "voice-item" +
          (group.id === state.guildId && channel.id === state.channelId ? " active" : "");
        button.setAttribute("data-guild", group.id);
        button.setAttribute("data-channel", channel.id);
        button.disabled = channel.type === 13;

        var body = document.createElement("div");
        var name = document.createElement("div");
        name.className = "voice-channel";
        name.textContent = channel.name;
        var server = document.createElement("div");
        server.className = "voice-server";
        server.textContent = group.name;
        body.appendChild(name);
        body.appendChild(server);

        var tag = document.createElement("span");
        tag.className = "voice-tag";
        tag.textContent = channel.type === 13 ? "stage" : group.id === state.guildId && channel.id === state.channelId ? "selected" : "join";
        button.appendChild(body);
        button.appendChild(tag);
        list.appendChild(button);
      });
    });

    if (!foundAny) {
      var empty = document.createElement("div");
      empty.className = "voice-empty";
      empty.textContent = query ? "No channels match “" + state.voiceQuery + "”." : "No voice channels available.";
      list.appendChild(empty);
    }
  }

  function selectVoice(guildId, channelId) {
    var found = findVoice(guildId, channelId);
    if (!found || found.channel.type === 13) return;
    state.guildId = guildId;
    state.channelId = channelId;
    state.voiceOpen = false;
    state.voiceQuery = "";
    $("voice-search").value = "";
    rememberVoice();
    hide($("play-msg"));
    renderVoice(false);
    updatePlayState();
  }

  function loadVoice() {
    renderVoice(true);
    var request = BRIDGE
      ? bridgeChannels().then(function (result) {
          if (result.status === 200 && result.data.ok && (result.data.groups || []).length > 0) {
            return result;
          }
          return api("/api/voice");
        }).catch(function () {
          return api("/api/voice");
        })
      : api("/api/voice");

    return request
      .then(function (result) {
        if (result.status === 401) {
          signedOut("Session expired. Sign in again.");
          return;
        }
        state.groups = result.status === 200 && result.data.ok ? result.data.groups || [] : [];
        restoreVoice();
        renderVoice(false);
        updatePlayState();
      })
      .catch(function () {
        state.groups = [];
        renderVoice(false);
      });
  }

  function renderResults() {
    var list = $("results");
    list.innerHTML = "";
    hide($("skeletons"));
    hide($("no-results"));
    hide($("results-hint"));

    if (state.mode === "search" && state.results.length > 0) {
      state.results.forEach(function (video) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "result" + (state.selected && state.selected.id === video.id ? " active" : "");

        var img = document.createElement("img");
        img.className = "thumb";
        setThumb(img, video.thumb, video.title);
        img.alt = "";
        img.loading = "lazy";

        var body = document.createElement("span");
        body.className = "result-body";

        var title = document.createElement("span");
        title.className = "result-title";
        title.textContent = video.title;

        var meta = document.createElement("span");
        meta.className = "result-meta";
        var channel = document.createElement("span");
        channel.textContent = video.channel;
        meta.appendChild(channel);
        if (video.duration) {
          var pill = document.createElement("span");
          pill.className = "pill";
          pill.textContent = video.duration;
          meta.appendChild(pill);
        }

        body.appendChild(title);
        body.appendChild(meta);
        button.appendChild(img);
        button.appendChild(body);
        button.addEventListener("click", function () {
          choose(video);
        });
        list.appendChild(button);
      });
      show(list);
      show($("results-hint"));
      return;
    }

    hide(list);
    if (state.mode === "search" && state.results.length === 0) show($("no-results"));
  }

  function renderSelected() {
    var video = state.selected;
    if (!video) {
      hide($("selected"));
      show($("no-selection"));
      return;
    }
    hide($("no-selection"));
    show($("selected"));
    setThumb($("sel-thumb"), video.thumb, video.title);
    $("sel-thumb").alt = "";
    setText($("sel-title"), video.title);
    setText($("sel-channel"), video.channel);
    if (video.duration) {
      setText($("sel-duration"), video.duration);
      show($("sel-duration"));
    } else {
      hide($("sel-duration"));
    }
    $("sel-link").href = video.url;
    updatePlayState();
  }

  function updatePlayState() {
    var canPlay = Boolean(state.selected && state.guildId && state.channelId);
    $("play").disabled = !canPlay || state.busy;
    if (state.selected && !canPlay) show($("need-target"));
    else hide($("need-target"));
  }

  function renderQueue() {
    var list = $("queue");
    list.innerHTML = "";
    if (state.queue.length === 0) {
      hide(list);
      show($("queue-empty"));
      hide($("queue-clear"));
      setText($("queue-sub"), "Empty.");
      return;
    }
    hide($("queue-empty"));
    show(list);
    show($("queue-clear"));
    setText($("queue-sub"), state.queue.length + " video" + (state.queue.length === 1 ? "" : "s"));
    state.queue.forEach(function (video, index) {
      var row = document.createElement("div");
      row.className = "queue-item";

      var num = document.createElement("span");
      num.className = "queue-num";
      num.textContent = String(index + 1);

      var title = document.createElement("span");
      title.className = "queue-title";
      title.textContent = video.title;

      var remove = document.createElement("button");
      remove.className = "icon-btn";
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + video.title);
      remove.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
      remove.addEventListener("click", function () {
        state.queue = state.queue.filter(function (v) {
          return v.id !== video.id;
        });
        if (state.selected && state.selected.id === video.id) state.selected = null;
        renderQueue();
        renderSelected();
        renderResults();
      });

      row.appendChild(num);
      row.appendChild(title);
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  function choose(video) {
    state.selected = video;
    state.queue = [video];
    hide($("play-msg"));
    renderResults();
    renderSelected();
    renderQueue();
  }

  function loadSession() {
    return api("/api/session").then(function (result) {
      if (result.status === 200 && result.data.ok) {
        state.account = result.data.account;
        hide($("boot"));
        hide($("login"));
        show($("app"));
        renderAccount();
        loadVoice();
        renderSelected();
        renderQueue();
        return true;
      }
      signedOut(result.status === 401 ? "" : result.data.error || "");
      return false;
    });
  }

  function login(event) {
    event.preventDefault();
    var token = $("token").value.trim();
    if (token.length < 20) return;
    hide($("login-error"));
    $("login-btn").disabled = true;
    setText($("login-label"), "Connecting…");
    state.token = token;
    var request = BRIDGE
      ? bridgeLogin(token)
      : api("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token }),
        });
    request
      .then(function (result) {
        if (result.status === 200 && result.data.ok) {
          localStorage.setItem(TOKEN_KEY, token);
          $("token").value = "";
          if (result.data.groups) {
            state.groups = result.data.groups;
            signedIn(result.data.account);
            return;
          }
          return loadSession();
        }
        state.token = null;
        setText($("login-error"), result.data.error || "Sign-in failed.");
        show($("login-error"));
      })
      .catch(function () {
        state.token = null;
        setText($("login-error"), "Network error. Try again.");
        show($("login-error"));
      })
      .then(function () {
        $("login-btn").disabled = false;
        setText($("login-label"), "Sign in as user");
      });
  }

  function search(event) {
    event.preventDefault();
    var query = $("query").value.trim();
    if (!query) return;
    hide($("search-error"));
    hide($("results"));
    hide($("results-hint"));
    hide($("no-results"));
    show($("skeletons"));
    $("search-btn").disabled = true;
    setText($("search-label"), "Searching…");
    state.busy = true;
    var searchRequest = BRIDGE && state.source === "kisskh"
      ? bridgeSearch(query)
      : api("/api/search?source=" + encodeURIComponent(state.source) + "&q=" + encodeURIComponent(query));
    searchRequest
      .then(function (result) {
        if (result.status === 401) {
          signedOut("Session expired. Sign in again.");
          return;
        }
        if (result.status === 200 && result.data.ok) {
          state.mode = result.data.mode;
          if (result.data.mode === "url") {
            state.results = [];
            choose(result.data.items[0]);
          } else {
            state.results = result.data.items || [];
          }
          renderResults();
          return;
        }
        setText($("search-error"), result.data.error || "Search failed.");
        show($("search-error"));
      })
      .catch(function () {
        setText($("search-error"), "Network error while searching.");
        show($("search-error"));
      })
      .then(function () {
        hide($("skeletons"));
        $("search-btn").disabled = false;
        setText($("search-label"), "Search");
        state.busy = false;
      });
  }

  function formatTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(total / 60);
    var rest = total % 60;
    return minutes + ":" + (rest < 10 ? "0" : "") + rest;
  }

  function showPlayer(label) {
    if (!BRIDGE) return;
    setText($("player-title"), label || (state.selected ? state.selected.title : "Live stream"));
    setText($("player-state"), "connecting…");
    setText($("player-cur"), "0:00");
    setText($("player-dur"), "--:--");
    setText($("player-toggle"), "Pause");
    setText($("player-vol-label"), Math.round(($("player-volume").value / 100) * 100) + "%");
    hide($("player-error"));
    show($("player"));
    state.playing = true;
    state.playerPaused = false;
    state.seeking = false;
    pollStatus();
    if (!state.statusTimer) state.statusTimer = setInterval(pollStatus, 1200);
  }

  function hidePlayer() {
    state.playing = false;
    state.playerPaused = false;
    state.seeking = false;
    hide($("player"));
    if (state.statusTimer) {
      clearInterval(state.statusTimer);
      state.statusTimer = null;
    }
    if (state.volumeTimer) {
      clearTimeout(state.volumeTimer);
      state.volumeTimer = null;
    }
  }

  function pollStatus() {
    if (!BRIDGE || !state.playing) return Promise.resolve(null);
    return directBridge("/status")
      .then(function (result) {
        if (result.status !== 200 || !result.data.ok) return null;
        var status = result.data;
        if (!status.playing) {
          hidePlayer();
          return status;
        }

        state.playerPaused = Boolean(status.paused);
        setText($("player-state"), status.lastError ? "failed" : status.paused ? "paused" : status.starting ? "resolving…" : "playing");
        setText($("player-title"), status.label || $("player-title").textContent);
        setText($("player-cur"), formatTime(status.position));
        setText($("player-dur"), status.duration ? formatTime(status.duration) : "--:--");
        setText($("player-toggle"), status.paused ? "Resume" : "Pause");
        if (!state.volumeTimer) {
          setText($("player-vol-label"), Math.round((status.volume || 0) * 100) + "%");
        }

        var seek = $("player-seek");
        var max = status.duration || Math.max(120, status.position + 60);
        seek.max = String(max);
        if (!state.seeking) seek.value = String(Math.min(status.position, max));
        if (!state.volumeTimer) {
          $("player-volume").value = String(Math.round((status.volume || 0) * 100));
        }

        if (status.lastError) {
          setText($("player-error"), status.lastError);
          show($("player-error"));
        } else {
          hide($("player-error"));
        }
        return status;
      })
      .catch(function () {
        setText($("player-state"), "bridge offline");
        return null;
      });
  }

  function sendControl(action, extra) {
    if (!BRIDGE) return Promise.resolve(null);
    var body = Object.assign({ action: action }, extra || {});
    return directBridge("/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (result) {
      if (result.status !== 200 || !result.data.ok) {
        setText($("player-error"), result.data.error || "Control failed.");
        show($("player-error"));
        return null;
      }
      hide($("player-error"));
      return result.data;
    }).catch(function () {
      setText($("player-error"), "Network error while controlling playback.");
      show($("player-error"));
      return null;
    });
  }

  function play() {
    if (!state.selected || !state.guildId || !state.channelId) return;
    state.busy = true;
    hide($("play-msg"));
    $("play").disabled = true;
    setText($("play-label"), "Sending…");
    var payload = {
      guildId: state.guildId,
      channelId: state.channelId,
      source: state.selected.source || "youtube",
      url: state.selected.url,
      title: state.selected.title,
    };
    var playRequest = BRIDGE ? bridgePlay(payload) : api("/api/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    playRequest
      .then(function (result) {
        var message = $("play-msg");
        if (result.status === 200 && result.data.ok) {
          message.className = "alert alert-ok";
          message.textContent = "Sent to the bot — joining the voice channel.";
          showPlayer(result.data.label || (state.selected ? state.selected.title : "Live stream"));
        } else {
          message.className = "alert alert-error";
          message.textContent = result.data.error || "The bot refused the request.";
          hidePlayer();
        }
        show(message);
      })
      .catch(function () {
        var message = $("play-msg");
        message.className = "alert alert-error";
        message.textContent = "Network error while contacting the bot.";
        hidePlayer();
        show(message);
      })
      .then(function () {
        setText($("play-label"), "Play in voice");
        state.busy = false;
        updatePlayState();
      });
  }

  function setSource(source) {
    state.source = source;
    var tabs = document.querySelectorAll(".source-tab");
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-source") === source);
    }
    $("query").placeholder =
      source === "kisskh"
        ? "John Wick, The Glory, Breaking Bad…"
        : "https://youtube.com/watch?v=…  or  lofi hip hop";
    state.results = [];
    state.mode = null;
    renderResults();
    hide($("no-results"));
  }

  function bind() {
    var tabs = document.querySelectorAll(".source-tab");
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener("click", function () {
        setSource(this.getAttribute("data-source"));
      });
    }
    $("login-form").addEventListener("submit", login);
    $("search-form").addEventListener("submit", search);
    $("query").addEventListener("input", function () {
      if (LINK_RE.test($("query").value.trim())) show($("link-chip"));
      else hide($("link-chip"));
    });
    $("voice-search").addEventListener("input", function () {
      state.voiceQuery = this.value;
      renderVoice(false);
    });
    $("voice-change").addEventListener("click", function () {
      state.voiceOpen = !state.voiceOpen;
      renderVoice(false);
      if (state.voiceOpen) $("voice-search").focus();
    });
    $("voice-list").addEventListener("click", function (event) {
      var item = event.target.closest(".voice-item");
      if (!item || item.disabled) return;
      selectVoice(item.getAttribute("data-guild"), item.getAttribute("data-channel"));
    });

    $("player-toggle").addEventListener("click", function () {
      var action = state.playerPaused ? "resume" : "pause";
      setText($("player-state"), action === "pause" ? "pausing…" : "resuming…");
      sendControl(action).then(function () {
        return pollStatus();
      });
    });
    $("player-stop").addEventListener("click", function () {
      sendControl("stop").then(function () {
        hidePlayer();
      });
    });
    $("player-seek").addEventListener("input", function () {
      state.seeking = true;
      setText($("player-cur"), formatTime(this.value));
    });
    $("player-seek").addEventListener("change", function () {
      var seconds = Number(this.value);
      sendControl("seek", { seconds: seconds }).then(function () {
        state.seeking = false;
        return pollStatus();
      });
    });
    $("player-volume").addEventListener("input", function () {
      var percent = Number(this.value);
      setText($("player-vol-label"), percent + "%");
      if (state.volumeTimer) clearTimeout(state.volumeTimer);
      state.volumeTimer = setTimeout(function () {
        state.volumeTimer = null;
        sendControl("volume", { volume: percent / 100 });
      }, 250);
    });

    $("play").addEventListener("click", play);
    $("queue-clear").addEventListener("click", function () {
      state.queue = [];
      state.selected = null;
      renderQueue();
      renderSelected();
      renderResults();
    });
    $("logout").addEventListener("click", function () {
      bridgeStop();
      api("/api/logout", { method: "POST" }).catch(function () {});
      signedOut("");
      hide($("login-error"));
    });
  }

  function boot() {
    bind();
    var saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) {
      signedOut("");
      return;
    }
    state.token = saved;
    if (!BRIDGE) {
      loadSession().catch(function () {
        signedOut("Could not reach the API.");
      });
      return;
    }
    bridgeLogin(saved)
      .then(function (result) {
        if (result.status !== 200 || !result.data.ok) {
          signedOut(result.data.error || "");
          return;
        }
        state.groups = result.data.groups;
        signedIn(result.data.account);
      })
      .catch(function () {
        signedOut("Could not reach the API.");
      });
  }

  boot();
})();
