// 领域错误：携带机器可读的 code，便于上层（队列、接口）区分"拒绝"与"程序错误"。
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const ERR = Object.freeze({
  CONCURRENT_WRITE: "CONCURRENT_WRITE", // 版本冲突（expectedVersion 不匹配）
  DUPLICATE_EVENT: "DUPLICATE_EVENT", // event_id 重复（断网重传/重复上传）
  UNKNOWN_STREAM: "UNKNOWN_STREAM",
  LATE_EVENT: "LATE_EVENT", // 业务发生时间早于该流已确认版本
  BAD_INPUT: "BAD_INPUT",
  CHAIN_MISMATCH: "CHAIN_MISMATCH", // 事件挂到了错误的责任链
  SIGN_OFF_REQUIRED: "SIGN_OFF_REQUIRED", // 缺少临床医生签署
  SIGNER_ROLE: "SIGNER_ROLE", // 签署人不是临床医生（影像建议不能替代签署）
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
  ALREADY_IN_RECORD: "ALREADY_IN_RECORD", // 已进入病历，撤回不能抹除，只能留痕
  RECEIVER_MISMATCH: "RECEIVER_MISMATCH", // 回执/预约来自非指定接收机构
  DUPLICATE_IMAGE: "DUPLICATE_IMAGE", // 同一影像重复上传
  STALE_CORRECTION: "STALE_CORRECTION", // 更正没有指向最新判读版本
});
