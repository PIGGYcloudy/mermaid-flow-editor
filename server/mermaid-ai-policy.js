const MAX_MERMAID_REQUEST_LENGTH = 120_000;

export class AiPolicyError extends Error {}

export function validateCustomMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 16) {
    throw new AiPolicyError('messages must contain between 1 and 16 items.');
  }

  let totalLength = 0;
  const normalized = messages.map((message) => {
    if (!message || typeof message !== 'object') {
      throw new AiPolicyError('Each message must be an object.');
    }
    if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new AiPolicyError('Each message must use a supported role and string content.');
    }
    totalLength += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (totalLength > MAX_MERMAID_REQUEST_LENGTH) {
    throw new AiPolicyError('messages are too large.');
  }
  return normalized;
}
