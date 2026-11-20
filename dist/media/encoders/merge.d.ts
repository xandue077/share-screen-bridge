import type { SupportedVideoCodec } from "../../utils.js";
import type { EncoderSettingsGetter } from "./index.js";
export declare const merge: (encoder: Partial<Record<SupportedVideoCodec, EncoderSettingsGetter>>) => EncoderSettingsGetter;
