// Kill-switch read state. `active=true` means the system_halt file exists at
// killSwitchPath and workers must STOP. The optional metadata fields are
// best-effort: the file might exist but be empty (legacy / manually created),
// in which case `active` is still true but the metadata is null.
export interface KillSwitchState {
	active: boolean;
	activated_at: string | null;
	activated_by: string | null;
	note: string | null;
}

export type KillSwitchAction = 'activate' | 'clear';

export interface KillSwitchToggleRequest {
	action: KillSwitchAction;
	note?: string;
}

export interface KillSwitchToggleResponse {
	ok: boolean;
	state: KillSwitchState;
}
