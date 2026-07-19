export type InterruptAction =
	| { readonly action: "cancel"; readonly requestId: string }
	| { readonly action: "exit" };

export class InterruptController {
	private cancellationRequested = false;

	interrupt(activeRequestId: string | undefined): InterruptAction {
		if (activeRequestId === undefined || this.cancellationRequested) return { action: "exit" };
		this.cancellationRequested = true;
		return { action: "cancel", requestId: activeRequestId };
	}

	turnTerminated(): void {
		this.cancellationRequested = false;
	}
}
