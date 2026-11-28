// What a failed turn's own code says to try, shown on the failure card before its recovery line (#1370). Only codes
// the panel can say something more useful for than the provider's message; the rest show the message alone.
import { ko } from "../locale.js";

export const FAILURE_HINT = {
	timeout: ko("The model took too long to answer. Retry, or pick a faster model or a lower reasoning effort.", "모델 응답이 너무 오래 걸렸어요. 다시 시도하거나, 더 빠른 모델이나 낮은 추론 강도를 골라 보세요.", "模型响应超时。请重试，或选择更快的模型或更低的推理强度。"),
	truncated: ko("The model used up its output before it answered. Lower the reasoning effort or raise the output limit, then retry.", "모델이 답하기 전에 출력 한도를 다 썼어요. 추론 강도를 낮추거나 출력 한도를 올린 뒤 다시 시도하세요.", "模型在作答前用完了输出额度。请降低推理强度或提高输出上限，然后重试。"),
};
