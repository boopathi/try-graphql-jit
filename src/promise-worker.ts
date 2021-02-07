/**
 * Original Source: https://github.com/nolanlawson/promise-worker/blob/master/index.js
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

let messageIds = 0;

export default class PromiseWorker {
  private callbacks: {
    [key: string]: (err: Error, result: any) => any;
  } = {};
  constructor(private worker: Worker) {
    worker.addEventListener("message", (e) => {
      this.onMessage(e);
    });
  }

  postMessage<TResult = any, TInput = any>(
    userMessage: TInput
  ): Promise<TResult> {
    const messageId = messageIds++;
    const messageToSend = [messageId, userMessage];

    return new Promise((resolve, reject) => {
      this.callbacks[messageId] = (error, result) => {
        if (error) {
          return reject(new Error(error.message));
        }
        resolve(result);
      };
      this.worker.postMessage(messageToSend);
    });
  }

  private onMessage(e: MessageEvent) {
    var message = e.data;
    if (!Array.isArray(message) || message.length < 2) {
      // Ignore - this message is not for us.
      return;
    }
    var messageId = message[0];
    var error = message[1];
    var result = message[2];

    var callback = this.callbacks[messageId];

    if (!callback) {
      // Ignore - user might have created multiple PromiseWorkers.
      // This message is not for us.
      return;
    }

    delete this.callbacks[messageId];
    callback(error, result);
  }
}
