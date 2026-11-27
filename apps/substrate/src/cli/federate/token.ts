// The join-token envelope lives with the client, which the TUI mints through.
export {
  decodeJoinToken,
  encodeJoinToken,
  JoinTokenError,
  type JoinTokenPayload
} from '@mnmal-ai/substrate-client';
