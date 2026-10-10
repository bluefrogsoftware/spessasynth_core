import type {
    MIDISystem,
    SoundBankManagerListEntry
} from "../../soundbank/types";
import type { BasicSoundBank } from "../../soundbank/basic_soundbank/basic_soundbank";
import { BasicPreset } from "../../soundbank/basic_soundbank/basic_preset";
import {
    type MIDIPatch,
    type MIDIPatchFull,
    MIDIPatchTools
} from "../../soundbank/basic_soundbank/midi_patch";
import { BankSelectHacks } from "../../utils/midi_hacks";
import { SpessaLog } from "../../utils/loggin";

class SoundBankManagerPreset extends BasicPreset {
    public constructor(p: BasicPreset, offset: number) {
        super(p.parentSoundBank, p.globalZone);
        this.bankMSB = BankSelectHacks.addBankOffset(p.bankMSB, offset, true);

        this.name = p.name;
        this.bankLSB = p.bankLSB;
        this.isGMGSDrum = p.isGMGSDrum;
        this.program = p.program;

        this.genre = p.genre;
        this.morphology = p.morphology;
        this.library = p.library;
        this.zones = p.zones;
    }
}

export class SoundBankManager {
    /**
     * All the sound banks, ordered from the most important to the least.
     */
    public soundBankList: SoundBankManagerListEntry[] = [];
    private readonly presetListChangeCallback: () => unknown;
    private readonly preservingPresetListChangeCallback: () => unknown;

    private selectablePresetList: SoundBankManagerPreset[] = [];

    /**
     * @param presetListChangeCallback Supplied by the parent synthesizer class,
     * this is called whenever the preset list changes.
     * @param preservingPresetListChangeCallback Refreshes inventory without resetting live channels.
     */
    public constructor(
        presetListChangeCallback: () => unknown,
        preservingPresetListChangeCallback: () => unknown
    ) {
        this.presetListChangeCallback = presetListChangeCallback;
        this.preservingPresetListChangeCallback =
            preservingPresetListChangeCallback;
    }

    private _presetList: MIDIPatchFull[] = [];

    /**
     * The list of all presets in the sound bank stack.
     */
    public get presetList() {
        return [...this._presetList];
    }

    /**
     * The current sound bank priority order.
     * @returns The IDs of the sound banks in the current order.
     */
    public get priorityOrder() {
        return this.soundBankList.map((s) => s.id);
    }

    /**
     * The current sound bank priority order.
     * @param newList The new order of sound bank IDs.
     */
    public set priorityOrder(newList: string[]) {
        this.soundBankList.sort(
            (a, b) => newList.indexOf(a.id) - newList.indexOf(b.id)
        );
        this.generatePresetList();
    }

    /**
     * Deletes a given sound bank by its ID.
     * @param id the ID of the sound bank to delete.
     */
    public deleteSoundBank(id: string) {
        if (this.soundBankList.length === 0) {
            SpessaLog.warn("1 soundbank left. Aborting!");
            return;
        }
        const index = this.soundBankList.findIndex((s) => s.id === id);
        if (index === -1) {
            throw new Error(`No sound bank with id "${id}"`);
        }
        this.soundBankList.splice(index, 1);
        this.generatePresetList();
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Adds a new sound bank with a given ID, or replaces an existing one.
     * @param font the sound bank to add.
     * @param id the ID of the sound bank.
     * @param bankOffset the bank offset of the sound bank.
     */
    public addSoundBank(font: BasicSoundBank, id: string, bankOffset = 0) {
        const foundBank = this.soundBankList.find((s) => s.id === id);
        if (foundBank === undefined) {
            this.soundBankList.push({
                id: id,
                soundBank: font,
                bankOffset: bankOffset
            });
        } else {
            // Replace
            foundBank.soundBank = font;
            foundBank.bankOffset = bankOffset;
        }
        this.generatePresetList();
    }

    /**
     * Registers banks in one inventory update without reselecting channels or resetting voices.
     * IDs must be unique. Banks may share an offset when their selectable patches do not collide.
     * @param soundBanks The new banks and their IDs and bank offsets.
     */
    public addSoundBanksPreservingVoices(
        soundBanks: readonly SoundBankManagerListEntry[]
    ) {
        const ids = new Set(this.soundBankList.map((entry) => entry.id));
        for (const entry of soundBanks) {
            if (entry.id.length === 0) {
                throw new Error("Sound bank IDs must not be empty");
            }
            if (
                !Number.isSafeInteger(entry.bankOffset) ||
                entry.bankOffset < 0 ||
                entry.bankOffset > 127
            ) {
                throw new Error(
                    `Invalid bank offset for sound bank "${entry.id}"`
                );
            }
            if (ids.has(entry.id)) {
                throw new Error(`Duplicate sound bank ID "${entry.id}"`);
            }
            ids.add(entry.id);
        }

        const selectablePatches = new Set(
            this.selectablePresetList.map((preset) => preset.toMIDIString())
        );
        for (const entry of soundBanks) {
            const entryPatches = new Set<string>();
            for (const preset of entry.soundBank.presets) {
                const selectablePreset = new SoundBankManagerPreset(
                    preset,
                    entry.bankOffset
                );
                const patch = selectablePreset.toMIDIString();
                if (selectablePatches.has(patch) || entryPatches.has(patch)) {
                    throw new Error(
                        `Duplicate selectable MIDI preset "${patch}"`
                    );
                }
                entryPatches.add(patch);
            }
            for (const patch of entryPatches) {
                selectablePatches.add(patch);
            }
        }

        const candidateSoundBankList = [...this.soundBankList, ...soundBanks];
        const candidateInventory = this.createPresetInventory(
            candidateSoundBankList
        );

        this.soundBankList = candidateSoundBankList;
        this.selectablePresetList = candidateInventory.selectablePresetList;
        this._presetList = candidateInventory.presetList;
        this.preservingPresetListChangeCallback();
    }

    /**
     * Gets a given preset from the sound bank stack.
     * @param patch The MIDI patch to search for.
     * @param system The MIDI system to select the preset for.
     * @returns An object containing the preset and its bank offset.
     * @internal
     */
    public getPreset(
        patch: MIDIPatch,
        system: MIDISystem
    ): BasicPreset | undefined {
        if (
            this.soundBankList.length === 0 ||
            this.selectablePresetList.length === 0
        ) {
            return undefined;
        }

        return MIDIPatchTools.selectPatch(
            this.selectablePresetList,
            patch,
            system
        );
    }

    // Clears the sound bank list and destroys all sound banks.
    public destroy() {
        for (const s of this.soundBankList) {
            s.soundBank.destroySoundBank();
        }
        this.soundBankList = [];
    }

    private generatePresetList() {
        const inventory = this.createPresetInventory(this.soundBankList);
        this.selectablePresetList = inventory.selectablePresetList;
        this._presetList = inventory.presetList;
        this.presetListChangeCallback();
    }

    private createPresetInventory(
        soundBankList: readonly SoundBankManagerListEntry[]
    ) {
        const presetList = new Array<SoundBankManagerPreset>();

        const addedPresets = new Set<string>();
        for (const s of soundBankList) {
            const bank = s.soundBank;
            const bankOffset = s.bankOffset;
            for (const p of bank.presets) {
                const selectablePreset = new SoundBankManagerPreset(
                    p,
                    bankOffset
                );
                if (!addedPresets.has(selectablePreset.toMIDIString())) {
                    addedPresets.add(selectablePreset.toMIDIString());
                    presetList.push(selectablePreset);
                }
            }
        }
        presetList.sort(MIDIPatchTools.compare.bind(MIDIPatchTools));
        const midiPresetList = presetList.map((p) => {
            return {
                bankMSB: p.bankMSB,
                bankLSB: p.bankLSB,
                program: p.program,
                isGMGSDrum: p.isGMGSDrum,
                name: p.name,
                isDrum: p.isDrum
            };
        });
        return { selectablePresetList: presetList, presetList: midiPresetList };
    }
}
