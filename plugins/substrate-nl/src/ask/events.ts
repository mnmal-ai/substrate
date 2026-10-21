import type { NlAskRequest, NlTrailEvent, NlOutcome as WireOutcome } from '@mnmal-ai/substrate/sdk';

/** The ask request and outcome are the wire types: one definition, shared with the client. */
export type AskRequest = NlAskRequest;
export type NlOutcome = WireOutcome;
/** What `runAsk` yields; the JSON encoding's trail is this sequence. */
export type NlEvent = NlTrailEvent;
