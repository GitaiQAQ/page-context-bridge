import {
  createNotification,
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  normalizeError,
  type RpcMeta,
  type RpcNotification,
  type RpcRequest,
} from "@page-context/shared-protocol";

type RuntimeHandler = (message: RpcRequest | RpcNotification, sender: chrome.runtime.MessageSender) => Promise<unknown> | unknown;

export async function sendRuntimeRequest<TResult>(method: string, params?: unknown): Promise<TResult> {
  const response = await chrome.runtime.sendMessage(createRequest(method, params));
  return unwrapRpcResponse<TResult>(response);
}

export async function sendRuntimeNotification(method: string, params?: unknown, meta?: RpcMeta): Promise<void> {
  await chrome.runtime.sendMessage(createNotification(method, params, meta));
}

export async function sendTabRequest<TResult>(tabId: number, method: string, params?: unknown): Promise<TResult> {
  const response = await chrome.tabs.sendMessage(tabId, createRequest(method, params));
  return unwrapRpcResponse<TResult>(response);
}

export function createRuntimeListener(handler: RuntimeHandler) {
  return (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean => {
    if (!isRpcRequest(message) && !isRpcNotification(message)) {
      return false;
    }

    const rpcMessage: RpcRequest | RpcNotification = message;

    Promise.resolve(handler(rpcMessage, sender))
      .then((result) => {
        if (!hasRequestId(rpcMessage)) {
          sendResponse({ ok: true });
          return;
        }

        sendResponse(createSuccessResponse(rpcMessage.id, result));
      })
      .catch((error) => {
        if (!hasRequestId(rpcMessage)) {
          sendResponse({ ok: false, error: normalizeError(error).message });
          return;
        }

        sendResponse(createErrorResponse(rpcMessage.id, error));
      });

    return true;
  };
}

export function unwrapRpcResponse<TResult>(message: unknown): TResult {
  if (!isRpcResponse(message)) {
    throw new Error("Expected JSON-RPC response envelope");
  }

  const rpcMessage = message;

  if ("error" in rpcMessage) {
    throw new Error(rpcMessage.error.message);
  }

  return rpcMessage.result as TResult;
}

function hasRequestId(message: RpcRequest | RpcNotification): message is RpcRequest {
  return "id" in message && typeof message.id === "string";
}
