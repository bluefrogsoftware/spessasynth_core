import { readFile } from "node:fs/promises";
import { SoundBankLoader, SpessaSynthProcessor } from "../../src/index";
import type { BasicPreset } from "../../src/soundbank/basic_soundbank/basic_preset";
import { MIDIPatchTools } from "../../src/soundbank/basic_soundbank/midi_patch";
import { BankSelectHacks } from "../../src/utils/midi_hacks";

const sampleRate = 48_000;
const soundBankPath = process.argv[2];
if (!soundBankPath) {
    throw new Error(
        "Pass the fixture SF3 path as the first argument to this test"
    );
}
const soundBankFile = new Uint8Array(await readFile(soundBankPath));

export function loadFixtureSoundBank() {
    return SoundBankLoader.fromArrayBuffer(
        new Uint8Array(soundBankFile).buffer
    );
}

export function effectivePatchKey(
    preset: BasicPreset,
    bankOffset: number,
    program = preset.program
) {
    return MIDIPatchTools.toMIDIString({
        bankMSB: BankSelectHacks.addBankOffset(
            preset.bankMSB,
            bankOffset,
            true
        ),
        bankLSB: preset.bankLSB,
        program,
        isGMGSDrum: preset.isGMGSDrum
    });
}

export function findAvailableProgram(
    preset: BasicPreset,
    usedPatches: ReadonlySet<string>,
    bankOffset: number
) {
    return Array.from(
        { length: 128 },
        (_, index) => (preset.program + index + 1) % 128
    ).find(
        (program) =>
            !usedPatches.has(effectivePatchKey(preset, bankOffset, program))
    );
}

export function findPlayableNote(preset: BasicPreset) {
    for (let note = 0; note <= 127; note++) {
        if (preset.getVoiceParameters(note, 110).length > 0) return note;
    }
    return undefined;
}

export function firstPlayableNote(preset: BasicPreset) {
    const note = findPlayableNote(preset);
    if (note === undefined) {
        throw new Error(`Preset ${preset.name} has no playable note zones`);
    }
    return note;
}

export async function processorWithFixture() {
    const processor = new SpessaSynthProcessor(sampleRate, {
        eventsEnabled: false,
        effectsEnabled: false
    });
    await processor.processorInitialized;
    processor.soundBankManager.addSoundBank(loadFixtureSoundBank(), "default");
    return processor;
}

export function render(processor: SpessaSynthProcessor, frameCount = 512) {
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    for (let offset = 0; offset < frameCount; offset += 128) {
        processor.process(
            left,
            right,
            offset,
            Math.min(128, frameCount - offset)
        );
    }
    return { left: [...left], right: [...right] };
}

export function pcmEnergy(pcm: { left: number[]; right: number[] }) {
    return (
        pcm.left.reduce((sum, sample) => sum + Math.abs(sample), 0) +
        pcm.right.reduce((sum, sample) => sum + Math.abs(sample), 0)
    );
}
