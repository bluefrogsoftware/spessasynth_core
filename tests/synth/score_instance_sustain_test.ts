import assert from "node:assert/strict";
import { test } from "node:test";
import {
    BasicSoundBank,
    SoundBankLoader,
    SpessaSynthProcessor
} from "../../src/index";

async function processorWithBank() {
    const processor = new SpessaSynthProcessor(48_000, {
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
    return processor;
}

function render(processor: SpessaSynthProcessor, frames: number) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    let energy = 0;
    for (let frame = 0; frame < frames; frame += 128) {
        const count = Math.min(128, frames - frame);
        processor.process(left, right, 0, count);
        for (let sample = 0; sample < count; sample++) {
            energy += left[sample] ** 2 + right[sample] ** 2;
        }
    }
    return energy;
}

function instanceVoices(processor: SpessaSynthProcessor, id: number) {
    const voices = processor.midiChannels[0].synthCore.voices.filter(
        (voice) => voice.isActive && voice.instanceId === id
    );
    assert.ok(voices.length > 0);
    return voices;
}

for (const pedalAfterAttack of [false, true]) {
    void test(`named release holds until pedal-up with pedal ${pedalAfterAttack ? "after" : "before"} attack`, async () => {
        const processor = await processorWithBank();
        try {
            if (!pedalAfterAttack) processor.controllerChange(0, 64, 127);
            const id = processor.noteOnInstance(0, 52, 110, 8192, 0);
            assert.ok(render(processor, 4800) > 0);
            if (pedalAfterAttack) processor.controllerChange(0, 64, 127);
            const voices = instanceVoices(processor, id);
            assert.equal(processor.releaseNoteInstance(id), "active");
            assert.equal(processor.releaseNoteInstance(id), "active");
            assert.ok(render(processor, 4800) > 0);
            for (const voice of voices) {
                assert.equal(voice.isHeld, true);
                assert.equal(voice.isInRelease, false);
                assert.equal(voice.releaseStartTime, Infinity);
            }
            processor.controllerChange(0, 64, 0);
            render(processor, 2048);
            for (const voice of voices) {
                assert.equal(voice.isHeld, false);
                assert.equal(voice.isInRelease, true);
            }
            const releaseTimes = voices.map((voice) => voice.releaseStartTime);
            processor.releaseNoteInstance(id);
            assert.deepEqual(
                voices.map((voice) => voice.releaseStartTime),
                releaseTimes
            );
        } finally {
            processor.destroySynthProcessor();
        }
    });
}

for (const pedalValue of [0, 63]) {
    void test(`named release without sustain retains release behavior at pedal ${pedalValue}`, async () => {
        const processor = await processorWithBank();
        try {
            processor.controllerChange(0, 64, pedalValue);
            const id = processor.noteOnInstance(0, 52, 110, 8192, 0);
            assert.ok(render(processor, 4800) > 0);
            const voices = instanceVoices(processor, id);
            processor.releaseNoteInstance(id);
            render(processor, 2048);
            for (const voice of voices) {
                assert.equal(voice.isHeld, false);
                assert.equal(voice.isInRelease, true);
            }
        } finally {
            processor.destroySynthProcessor();
        }
    });
}

void test("mono overrides sustain for named release", async () => {
    const processor = await processorWithBank();
    try {
        processor.controllerChange(0, 126, 0);
        assert.equal(processor.midiChannels[0].midiParameters.polyMode, false);
        processor.controllerChange(0, 64, 127);
        const id = processor.noteOnInstance(0, 52, 110, 8192, 0);
        assert.ok(render(processor, 4800) > 0);
        const voices = instanceVoices(processor, id);
        processor.releaseNoteInstance(id);
        render(processor, 2048);
        for (const voice of voices) {
            assert.equal(voice.isHeld, false);
            assert.equal(voice.isInRelease, true);
        }
    } finally {
        processor.destroySynthProcessor();
    }
});

void test("sustain holds every owned layer without releasing other same-key notes", async () => {
    const processor = await processorWithBank();
    try {
        const channel = processor.midiChannels[0];
        const preset = channel.preset;
        assert.ok(preset);
        preset.zones.push(...preset.zones);
        processor.controllerChange(0, 64, 64);
        const first = processor.noteOnInstance(0, 52, 110, 8192, 0);
        const second = processor.noteOnInstance(0, 52, 110, 8192, 0);
        processor.noteOn(0, 52, 110);
        assert.ok(render(processor, 4800) > 0);
        const firstLayers = instanceVoices(processor, first);
        const secondLayers = instanceVoices(processor, second);
        const normalLayers = channel.synthCore.voices.filter(
            (voice) => voice.isActive && voice.instanceId === undefined
        );
        assert.equal(firstLayers.length, 2);
        assert.equal(secondLayers.length, 2);
        assert.equal(normalLayers.length, 2);
        processor.releaseNoteInstance(first);
        processor.releaseNoteInstance(first);
        assert.ok(render(processor, 4800) > 0);
        for (const voice of firstLayers) {
            assert.equal(voice.isHeld, true);
            assert.equal(voice.isInRelease, false);
        }
        processor.controllerChange(0, 64, 0);
        render(processor, 2048);
        assert.ok(firstLayers.every((voice) => voice.isInRelease));
        for (const voice of [...secondLayers, ...normalLayers]) {
            assert.equal(voice.isHeld, false);
            assert.equal(voice.isInRelease, false);
            assert.equal(voice.releaseStartTime, Infinity);
        }
        processor.noteOff(0, 52);
        render(processor, 2048);
        assert.ok(normalLayers.every((voice) => voice.isInRelease));
        assert.ok(secondLayers.every((voice) => !voice.isInRelease));
    } finally {
        processor.destroySynthProcessor();
    }
});
