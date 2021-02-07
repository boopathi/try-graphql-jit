/**
 * Original Source: https://github.com/nolanlawson/promise-worker/blob/master/register.js
 *
 * This is a fork because the type definitions in the original
 * source is wrong which makes it impossible to bundle with
 * the latest parcel-bundler 2.0-beta (as of this writing)
 *
 * LICENSE:
 *
 * https://github.com/nolanlawson/promise-worker/blob/master/LICENSE

Copyright [yyyy] Nolan Lawson

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
 *
 */

function isPromise(obj: any) {
  // via https://unpkg.com/is-promise@2.1.0/index.js
  return (
    !!obj &&
    (typeof obj === "object" || typeof obj === "function") &&
    typeof obj.then === "function"
  );
}

export default function registerPromiseWorker<
  TMessageIn = any,
  TMessageOut = any
>(callback: (message: TMessageIn) => Promise<TMessageOut> | TMessageOut) {
  function postOutgoingMessage(
    e: MessageEvent,
    messageId: string,
    error?: Error | null,
    result?: any
  ) {
    function postMessage(msg: [string, { message: string } | null, any?]) {
      self.postMessage(msg);
    }

    if (error) {
      /* istanbul ignore else */
      if (typeof console !== "undefined" && "error" in console) {
        // This is to make errors easier to debug. I think it's important
        // enough to just leave here without giving the user an option
        // to silence it.
        console.error("Worker caught an error:", error);
      }

      postMessage([
        messageId,
        {
          message: error.message,
        },
      ]);
    } else {
      postMessage([messageId, null, result]);
    }
  }

  function tryCatchFunc(callback: any, message: any) {
    try {
      return { res: callback(message) };
    } catch (e) {
      return { err: e };
    }
  }

  function handleIncomingMessage(
    e: MessageEvent,
    callback: Function,
    messageId: string,
    message: any
  ) {
    const result = tryCatchFunc(callback, message);

    if (result.err) {
      postOutgoingMessage(e, messageId, result.err);
    } else if (!isPromise(result.res)) {
      postOutgoingMessage(e, messageId, null, result.res);
    } else {
      result.res.then(
        (finalResult: any) => {
          postOutgoingMessage(e, messageId, null, finalResult);
        },
        (finalError: any) => {
          postOutgoingMessage(e, messageId, finalError);
        }
      );
    }
  }

  function onIncomingMessage(e: MessageEvent) {
    const payload = e.data;
    if (!Array.isArray(payload) || payload.length !== 2) {
      // message doens't match communication format; ignore
      return;
    }
    const messageId = payload[0];
    const message = payload[1];

    if (typeof callback !== "function") {
      postOutgoingMessage(
        e,
        messageId,
        new Error("Please pass a function into register().")
      );
    } else {
      handleIncomingMessage(e, callback, messageId, message);
    }
  }

  self.addEventListener("message", onIncomingMessage);
}
