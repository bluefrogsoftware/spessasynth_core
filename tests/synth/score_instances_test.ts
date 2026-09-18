import assert from "node:assert/strict";
import { test } from "node:test";
import {
    BasicSoundBank,
    SoundBankLoader,
    SpessaSynthProcessor
} from "../../src/index";
import { GeneratorTypes } from "../../src/soundbank/basic_soundbank/generator_types";

const RATE = 48_000;
const CENTER = 8192;

async function processorWithBank(oneShot = false) {
    const processor = new SpessaSynthProcessor(RATE, {
        eventsEnabled: false,
        effectsEnabled: false
    });
    await processor.processorInitialized;
    const bytes = new Uint8Array(BasicSoundBank.getSampleSoundBankFile());
    processor.soundBankManager.addSoundBank(
        SoundBankLoader.fromArrayBuffer(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
            )
        ),
        "test"
    );
    const preset = processor.midiChannels[0].preset;
    assert.ok(preset);
    const instrument = preset.zones[0].instrument;
    assert.ok(instrument);
    instrument.zones.pop();
    if (oneShot) {
        instrument.globalZone.setGenerator(GeneratorTypes.sampleModes, 0);
    }
    return processor;
}

function render(processor: SpessaSynthProcessor, frames: number) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let frame = 0; frame < frames; frame += 128) {
        processor.process(left, right, 0, Math.min(128, frames - frame));
    }
}

void test("same-key identities retain independent pitch through release", async () => {
    const processor = await processorWithBank();
    try {
        const first = processor.noteOnInstance(0, 52, 110, CENTER + 1024);
        const second = processor.noteOnInstance(0, 52, 110, CENTER);
        assert.notEqual(first, second);
        assert.equal(processor.noteInstanceStatus(first), "active");
        assert.equal(processor.noteInstanceStatus(second), "active");
        assert.equal(processor.releaseNoteInstance(first), "active");
        assert.equal(
            processor.pitchNoteInstance(first, CENTER - 512),
            "active"
        );
        assert.equal(processor.noteInstanceStatus(second), "active");
        render(processor, 1024);
        assert.equal(
            processor.pitchNoteInstance(first, CENTER + 512),
            "active"
        );
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("stolen and reused voice slots cannot be controlled through old identities", async () => {
    const processor = await processorWithBank();
    try {
        processor.setSystemParameter("autoAllocateVoices", false);
        processor.setSystemParameter("voiceCap", 1);
        const first = processor.noteOnInstance(0, 52, 110, CENTER);
        const second = processor.noteOnInstance(0, 52, 110, CENTER + 512);
        assert.equal(processor.noteInstanceStatus(first), "ended");
        assert.equal(processor.pitchNoteInstance(first, CENTER - 512), "ended");
        assert.equal(processor.releaseNoteInstance(first), "ended");
        assert.equal(processor.noteInstanceStatus(second), "active");
        assert.throws(
            () => processor.pitchNoteInstance(second + 10, CENTER),
            /Unknown note instance/
        );
        processor.stopAllChannels(true);
        assert.equal(processor.noteInstanceStatus(second), "ended");
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("one-shot sample exhaustion ends its identity without a note-off", async () => {
    const processor = await processorWithBank(true);
    try {
        processor.midiChannels[0].setDrums(true);
        const id = processor.noteOnInstance(0, 65, 110, CENTER);
        assert.equal(processor.noteInstanceStatus(id), "active");
        render(processor, RATE * 5);
        assert.equal(processor.noteInstanceStatus(id), "ended");
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("one attack controls every layer of a layered preset", async () => {
    const processor = await processorWithBank();
    try {
        const preset = processor.midiChannels[0].preset;
        assert.ok(preset);
        // Duplicate the real preset's zones so its existing sample becomes two
        // Simultaneous layers without introducing a new binary sound bank.
        preset.zones.push(...preset.zones);
        const id = processor.noteOnInstance(0, 52, 110, CENTER);
        render(processor, 128);
        assert.equal(processor.voiceCount, 2);
        assert.equal(processor.pitchNoteInstance(id, CENTER + 512), "active");
        assert.equal(processor.releaseNoteInstance(id), "active");
        assert.equal(processor.noteInstanceStatus(id), "active");
        processor.stopAllChannels(true);
        assert.equal(processor.noteInstanceStatus(id), "ended");
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("a layered attack above the voice cap fails without an orphaned layer", async () => {
    const processor = await processorWithBank();
    try {
        const preset = processor.midiChannels[0].preset;
        assert.ok(preset);
        preset.zones.push(...preset.zones);
        processor.setSystemParameter("autoAllocateVoices", false);
        processor.setSystemParameter("voiceCap", 1);
        assert.throws(
            () => processor.noteOnInstance(0, 52, 110, CENTER),
            /requires 2 voices but cap is 1/
        );
        render(processor, 128);
        assert.equal(processor.voiceCount, 0);
        assert.equal(processor.noteInstanceStatus(1), "ended");
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("a layered attack steals older voices before its own layers", async () => {
    const processor = await processorWithBank();
    try {
        processor.setSystemParameter("autoAllocateVoices", false);
        processor.setSystemParameter("voiceCap", 2);
        const first = processor.noteOnInstance(0, 52, 110, CENTER);
        const second = processor.noteOnInstance(0, 53, 110, CENTER);
        const preset = processor.midiChannels[0].preset;
        assert.ok(preset);
        preset.zones.push(...preset.zones);

        const layered = processor.noteOnInstance(0, 54, 110, CENTER);
        assert.equal(processor.noteInstanceStatus(first), "ended");
        assert.equal(processor.noteInstanceStatus(second), "ended");
        assert.equal(processor.noteInstanceStatus(layered), "active");
        render(processor, 128);
        assert.equal(processor.voiceCount, 2);
        assert.equal(
            processor.pitchNoteInstance(layered, CENTER + 512),
            "active"
        );
        assert.equal(processor.releaseNoteInstance(layered), "active");
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("reset and destruction end known identities", async () => {
    const processor = await processorWithBank();
    const first = processor.noteOnInstance(0, 52, 110, CENTER);
    assert.equal(processor.noteInstanceStatus(first), "active");
    processor.reset();
    assert.equal(processor.noteInstanceStatus(first), "ended");
    render(processor, 128);
    assert.equal(processor.voiceCount, 0);
    const second = processor.noteOnInstance(0, 52, 110, CENTER);
    assert.equal(processor.noteInstanceStatus(second), "active");
    processor.destroySynthProcessor();
    assert.equal(processor.noteInstanceStatus(second), "ended");
});
