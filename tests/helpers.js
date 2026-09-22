import { EventStore } from "../src/event-store.js";
import { ImagingService } from "../src/imaging-service.js";
import { ReceiverDirectory } from "../src/receiver-directory.js";
import { CATEGORY } from "../src/disclosure.js";
import { ROLE } from "../src/vocabulary.js";

// 固定时钟，方便断言时间语义。
export function makeContext(start = "2026-09-22T08:00:00+08:00") {
  let t = Date.parse(start);
  const clock = () => new Date(t).toISOString();
  const advance = (minutes) => { t += minutes * 60_000; };
  const store = new EventStore({ clock });
  const directory = new ReceiverDirectory();
  const service = new ImagingService({ store, directory, clock });
  return { service, store, directory, clock, advance };
}

export const ACTORS = {
  grassDoctor: { id: "dr-wang-fuping", role: ROLE.REFERRING_CLINICIAN, orgId: "org-fuping-county" },
  expert: { id: "expert-li", role: ROLE.IMAGING_EXPERT, orgId: "org-fuping-county" },
  ffrAnalyst: { id: "analyst-zhao", role: ROLE.CT_FFR_ANALYST, orgId: "org-fuping-county" },
  receiver: { id: "dr-sun-center", role: ROLE.RECEIVING_CLINICIAN, orgId: "org-provincial-center" },
  patient: (id) => ({ id, role: ROLE.PATIENT }),
};

export const FULL_CATEGORIES = [...new Set(Object.values(CATEGORY))];

export { CATEGORY };
