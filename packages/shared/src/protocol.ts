// WebSocket message types (binary protocol)
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_AUTH = 2;
export const MSG_CONTROL = 3;

// Control message subtypes
export const CONTROL_LOCK_REQUEST = 10;
export const CONTROL_LOCK_GRANTED = 11;
export const CONTROL_LOCK_DENIED = 12;
export const CONTROL_LOCK_RELEASED = 13;
export const CONTROL_LOCK_HEARTBEAT = 14;
export const CONTROL_USER_JOINED = 20;
export const CONTROL_USER_LEFT = 21;
export const CONTROL_ACCESS_REVOKED = 30;
export const CONTROL_ERROR = 40;
