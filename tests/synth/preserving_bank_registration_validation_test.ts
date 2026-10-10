import assert from "node:assert/strict";
import { test } from "node:test";
import { BasicSoundBank } from "../../src/index";
import { MIDIPatchTools } from "../../src/soundbank/basic_soundbank/midi_patch";
import {
    effectivePatchKey,
    findAvailableProgram,
    loadFixtureSoundBank,
    processorWithFixture
} from "./preserving_bank_registration_test_support";

void test("batch registration validates IDs, offsets, and patch collisions", async () => {
    await BasicSoundBank.isSF3DecoderReady;
    const processor = await processorWithFixture();
    let source: BasicSoundBank | undefined;
    let bankA: BasicSoundBank | undefined;
    let bankB: BasicSoundBank | undefined;
    let duplicateIdBank: BasicSoundBank | undefined;
    let invalidOffsetBank: BasicSoundBank | undefined;
    let collisionBank: BasicSoundBank | undefined;
    try {
        source = loadFixtureSoundBank();
        const existingKeys = new Set(
            processor.soundBankManager.presetList.map((preset) =>
                MIDIPatchTools.toMIDIString(preset)
            )
        );
        const firstPreset = source.presets.find((preset) => !preset.isDrum);
        assert.ok(firstPreset);

        bankA = loadFixtureSoundBank();
        bankB = loadFixtureSoundBank();
        const bankAPreset = bankA.presets.find(
            (preset) =>
                effectivePatchKey(preset, 0) ===
                effectivePatchKey(firstPreset, 0)
        );
        const bankBPreset = bankB.presets.find(
            (preset) =>
                effectivePatchKey(preset, 0) ===
                effectivePatchKey(firstPreset, 0)
        );
        assert.ok(bankAPreset);
        assert.ok(bankBPreset);
        bankA.presets = [bankAPreset];
        const secondProgram = findAvailableProgram(
            firstPreset,
            existingKeys,
            1
        );
        if (secondProgram === undefined) {
            throw new Error("Fixture has no free GM program at bank offset 1");
        }
        bankBPreset.program = secondProgram;
        bankB.presets = [bankBPreset];

        processor.soundBankManager.addSoundBanksPreservingVoices([
            { id: "same-set-first-program", soundBank: bankA, bankOffset: 1 },
            { id: "same-set-second-program", soundBank: bankB, bankOffset: 1 }
        ]);
        const registeredBankList = [
            ...processor.soundBankManager.soundBankList
        ];
        const registeredKeys = processor.soundBankManager.presetList.map(
            (preset) => MIDIPatchTools.toMIDIString(preset)
        );
        assert.equal(
            registeredBankList.filter((entry) => entry.bankOffset === 1).length,
            2
        );
        assert.ok(registeredKeys.includes(effectivePatchKey(firstPreset, 1)));
        assert.ok(
            registeredKeys.includes(
                effectivePatchKey(firstPreset, 1, secondProgram)
            )
        );

        duplicateIdBank = loadFixtureSoundBank();
        assert.throws(
            () =>
                processor.soundBankManager.addSoundBanksPreservingVoices([
                    {
                        id: "same-set-first-program",
                        soundBank: duplicateIdBank!,
                        bankOffset: 2
                    }
                ]),
            /Duplicate sound bank ID "same-set-first-program"/
        );
        assert.deepEqual(
            processor.soundBankManager.soundBankList,
            registeredBankList
        );
        assert.deepEqual(
            processor.soundBankManager.presetList.map((preset) =>
                MIDIPatchTools.toMIDIString(preset)
            ),
            registeredKeys
        );

        invalidOffsetBank = loadFixtureSoundBank();
        assert.throws(
            () =>
                processor.soundBankManager.addSoundBanksPreservingVoices([
                    {
                        id: "negative-offset",
                        soundBank: invalidOffsetBank!,
                        bankOffset: -1
                    }
                ]),
            /Invalid bank offset/
        );
        assert.deepEqual(
            processor.soundBankManager.soundBankList,
            registeredBankList
        );
        assert.deepEqual(
            processor.soundBankManager.presetList.map((preset) =>
                MIDIPatchTools.toMIDIString(preset)
            ),
            registeredKeys
        );

        collisionBank = loadFixtureSoundBank();
        const collidingPreset = collisionBank.presets.find(
            (preset) =>
                !preset.isDrum && existingKeys.has(effectivePatchKey(preset, 0))
        );
        assert.ok(collidingPreset);
        collisionBank.presets = [collidingPreset];
        assert.throws(
            () =>
                processor.soundBankManager.addSoundBanksPreservingVoices([
                    {
                        id: "patch-collision",
                        soundBank: collisionBank!,
                        bankOffset: 0
                    }
                ]),
            /Duplicate selectable MIDI preset/
        );
        assert.deepEqual(
            processor.soundBankManager.soundBankList,
            registeredBankList
        );
        assert.deepEqual(
            processor.soundBankManager.presetList.map((preset) =>
                MIDIPatchTools.toMIDIString(preset)
            ),
            registeredKeys
        );

        const duplicateProgram = findAvailableProgram(
            collidingPreset,
            new Set(registeredKeys),
            1
        );
        if (duplicateProgram === undefined) {
            throw new Error(
                "Fixture has no free GM program for duplicate test"
            );
        }
        collidingPreset.program = duplicateProgram;
        collisionBank.presets = [collidingPreset, collidingPreset];
        assert.throws(
            () =>
                processor.soundBankManager.addSoundBanksPreservingVoices([
                    {
                        id: "within-bank-duplicate",
                        soundBank: collisionBank!,
                        bankOffset: 1
                    }
                ]),
            /Duplicate selectable MIDI preset/
        );
        assert.deepEqual(
            processor.soundBankManager.soundBankList,
            registeredBankList
        );
        assert.deepEqual(
            processor.soundBankManager.presetList.map((preset) =>
                MIDIPatchTools.toMIDIString(preset)
            ),
            registeredKeys
        );
    } finally {
        for (const bank of [
            source,
            duplicateIdBank,
            invalidOffsetBank,
            collisionBank
        ]) {
            if (
                bank &&
                !processor.soundBankManager.soundBankList.some(
                    (entry) => entry.soundBank === bank
                )
            ) {
                bank.destroySoundBank();
            }
        }
        processor.destroySynthProcessor();
    }
});
