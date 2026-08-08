// A late IPC response must never overwrite a newer user action. Keeping this
// tiny gate outside the component makes the ordering contract directly testable.
export function createShortcutRequestGate() {
  let token = 0;
  return {
    next() {
      token += 1;
      return token;
    },
    isCurrent(value) {
      return value === token;
    },
    current() {
      return token;
    },
  };
}
