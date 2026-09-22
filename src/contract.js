const required = ["event_id", "kind", "occurred_at", "subject_id", "version"];
export function validate(record) { return required.filter((name) => !(name in record)); }
