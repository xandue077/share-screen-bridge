import type { SupportedVideoCodec } from "../../utils.js";
export type EncoderSettings = {
    name: string;
    options: string[];
    globalOptions?: string[];
    outFilters?: string[];
};
export type EncoderSettingsGetter = (bitrate: number, bitrateMax: number) => Partial<Record<SupportedVideoCodec, EncoderSettings>>;
import { merge } from "./merge.js";
import { nvenc } from "./nvenc.js";
import { software } from "./software.js";
import { vaapi } from "./vaapi.js";
declare const Encoders: {
    software: typeof software;
    nvenc: typeof nvenc;
    vaapi: typeof vaapi;
    merge: typeof merge;
};
export { Encoders };
