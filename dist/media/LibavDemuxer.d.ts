import type { Readable } from "node:stream";
import type { CodecParameters } from "node-av";
import { type Stream } from "node-av";
import { AVCodecID } from "./LibavCodecId.js";
type MediaStreamInfoCommon = {
    index: number;
    codec: AVCodecID;
    codecpar: CodecParameters;
    avStream: Stream;
};
export type VideoStreamInfo = MediaStreamInfoCommon & {
    width: number;
    height: number;
    framerate_num: number;
    framerate_den: number;
};
export type AudioStreamInfo = MediaStreamInfoCommon & {
    sample_rate: number;
};
type DemuxerOptions = {
    format: "matroska" | "nut";
};
export declare function demux(input: Readable, { format }: DemuxerOptions): Promise<{
    video: {
        index: number;
        codec: AVCodecID;
        codecpar: CodecParameters;
        avStream: Stream;
        width: number;
        height: number;
        framerate_num: number;
        framerate_den: number;
        stream: Readable;
    } | undefined;
    audio: {
        index: number;
        codec: AVCodecID;
        codecpar: CodecParameters;
        avStream: Stream;
        sample_rate: number;
        stream: Readable;
    } | undefined;
}>;
export {};
