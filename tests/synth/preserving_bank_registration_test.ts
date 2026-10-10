import assert from "node:assert/strict";
import { test } from "node:test";
import { BasicSoundBank } from "../../src/index";
import { MIDIPatchTools } from "../../src/soundbank/basic_soundbank/midi_patch";
import { BankSelectHacks } from "../../src/utils/midi_hacks";
import {
    effectivePatchKey,
    firstPlayableNote,
    findPlayableNote,
    loadFixtureSoundBank,
    pcmEnergy,
    processorWithFixture,
    render
} from "./preserving_bank_registration_test_support";

void test("bank registration preserves playing voices and supports later attacks", async () => {
    await BasicSoundBank.isSF3DecoderReady;
    const subject = await processorWithFixture();
    const reference = await processorWithFixture();
    let alternateBank: BasicSoundBank | undefined;
    let source: BasicSoundBank | undefined;
    try {
        const initialPresetEntry = subject.soundBankManager.presetList.find(
            (preset) => !preset.isDrum
        );
        assert.ok(initialPresetEntry);
        const initialPatch = {
            bankMSB: initialPresetEntry.bankMSB,
            bankLSB: initialPresetEntry.bankLSB,
            program: initialPresetEntry.program,
            isGMGSDrum: initialPresetEntry.isGMGSDrum
        };
        subject.midiChannels[0].setPatch(initialPatch);
        reference.midiChannels[0].setPatch(initialPatch);
        const activePreset = subject.midiChannels[0].preset;
        assert.ok(activePreset);
        const note = firstPlayableNote(activePreset);
        subject.controllerChange(0, 7, 93);
        reference.controllerChange(0, 7, 93);
        subject.pitchWheel(0, 9000);
        reference.pitchWheel(0, 9000);

        const subjectInstance = subject.noteOnInstance(0, note, 110, 8192, 0);
        const referenceInstance = reference.noteOnInstance(
            0,
            note,
            110,
            8192,
            0
        );
        assert.equal(subject.noteInstanceStatus(subjectInstance), "active");
        assert.equal(reference.noteInstanceStatus(referenceInstance), "active");
        const initialSubjectPcm = render(subject);
        const initialReferencePcm = render(reference);
        assert.ok(pcmEnergy(initialReferencePcm) > 0);
        assert.deepEqual(initialSubjectPcm, initialReferencePcm);

        const controllerState = subject.midiChannels[0].midiControllers.slice();
        const pitchState = subject.midiChannels[0].pitchWheels.slice();
        const currentTime = subject.currentTime;
        source = loadFixtureSoundBank();
        const existingPatches = new Set(
            subject.soundBankManager.presetList.map((preset) =>
                MIDIPatchTools.toMIDIString(preset)
            )
        );
        const sourcePreset = source.presets.find(
            (preset) =>
                !preset.isDrum &&
                preset.bankMSB < 127 &&
                findPlayableNote(preset) !== undefined &&
                !existingPatches.has(effectivePatchKey(preset, 1))
        );
        assert.ok(sourcePreset);
        alternateBank = loadFixtureSoundBank();
        alternateBank.presets = [
            alternateBank.presets.find(
                (preset) =>
                    effectivePatchKey(preset, 0) ===
                    effectivePatchKey(sourcePreset, 0)
            )!
        ];

        subject.soundBankManager.addSoundBanksPreservingVoices([
            { id: "alternate", soundBank: alternateBank, bankOffset: 1 }
        ]);

        assert.equal(subject.noteInstanceStatus(subjectInstance), "active");
        assert.equal(reference.noteInstanceStatus(referenceInstance), "active");
        assert.equal(subject.currentTime, currentTime);
        assert.strictEqual(subject.midiChannels[0].preset, activePreset);
        assert.deepEqual(
            subject.midiChannels[0].midiControllers,
            controllerState
        );
        assert.deepEqual(subject.midiChannels[0].pitchWheels, pitchState);
        const continuedSubjectPcm = render(subject);
        const continuedReferencePcm = render(reference);
        assert.ok(pcmEnergy(continuedReferencePcm) > 0);
        assert.deepEqual(continuedSubjectPcm, continuedReferencePcm);

        const alternatePatch = {
            bankMSB: BankSelectHacks.addBankOffset(
                sourcePreset.bankMSB,
                1,
                true
            ),
            bankLSB: sourcePreset.bankLSB,
            program: sourcePreset.program,
            isGMGSDrum: sourcePreset.isGMGSDrum
        };
        const selectedPreset = subject.soundBankManager.getPreset(
            alternatePatch,
            "gs"
        );
        assert.ok(selectedPreset);
        assert.strictEqual(selectedPreset.parentSoundBank, alternateBank);
        subject.midiChannels[0].setPatch(alternatePatch);
        const selectedChannelPreset = subject.midiChannels[0].preset;
        assert.ok(selectedChannelPreset);
        assert.strictEqual(
            selectedChannelPreset.parentSoundBank,
            alternateBank
        );
        const futureNote = firstPlayableNote(selectedChannelPreset);
        const futureInstance = subject.noteOnInstance(
            0,
            futureNote,
            110,
            8192,
            0
        );
        assert.equal(subject.noteInstanceStatus(futureInstance), "active");
    } finally {
        for (const bank of [source, alternateBank]) {
            if (
                bank &&
                !subject.soundBankManager.soundBankList.some(
                    (entry) => entry.soundBank === bank
                )
            ) {
                bank.destroySoundBank();
            }
        }
        subject.destroySynthProcessor();
        reference.destroySynthProcessor();
    }
});
