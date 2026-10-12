import contracts from './contracts.json' with { type: 'json' };

const policyErrors: Record<string, [string, boolean, string]> = {
  TOOL_DISABLED: ['该工具未被本机策略启用。', false, 'check_enabled_tools'],
  WRITE_SCOPE_REQUIRED: ['真实写入需要本机配置非空空间白名单。', false, 'configure_write_spaces'],
  SPACE_NOT_ALLOWED: ['目标空间不在本机写入白名单中。', false, 'check_write_spaces'],
  POLICY_INVALID: ['本机工具或空间策略无效，请核对 policy.json。', false, 'check_policy'],
};
const errors = { ...(contracts.errors as unknown as Record<string, [string, boolean, string]>), ...policyErrors };

export class ReadError extends Error {
  constructor(public code = 'READ_FAILED', public httpStatus?: number,
    public retryAfter?: number, public retryable?: boolean) {
    super(errors[code]?.[0]
      ?? '当前试用阶段尚未支持该操作。');
  }
  details() {
    const entry = errors[this.code];
    return { code: this.code, message: this.message, retryable: this.retryable ?? entry?.[1] ?? false,
      next_step: entry?.[2] ?? 'check_supported_operations',
      ...(this.httpStatus !== undefined ? { http_status: this.httpStatus } : {}),
      ...(this.retryAfter !== undefined ? { retry_after: this.retryAfter } : {}) };
  }
}

export function failure(error: unknown) {
  const safe = error instanceof ReadError ? error : new ReadError();
  const details = safe.details();
  return { isError: true, _meta: { error: details }, content: [
    { type: 'text' as const, text: safe.message },
    { type: 'text' as const, text: JSON.stringify({ error: details }) },
  ] };
}
