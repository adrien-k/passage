function parseHeaders(headerLines) {
  const headers = {}
  for (const line of headerLines) {
    const [key, value] = line.split(": ");
    if (!headers[key]) {
      headers[key] = [];
    }
    headers[key].push(value);
  }
  return headers;
}

export function parseReqHead(head) {
  const headLines = head.split("\r\n");
  const [method, path, version] = headLines[0].split(" ");
  const headers = parseHeaders(headLines.slice(1));
  return { version, method, path, headers };
}

export function serializeReqHead({ method, path, version, headers }) {
  let head = [method, path, version].join(" ")
  for (const key of Object.keys(headers)) {
    for (const value of headers[key]) {
      head += `\r\n${key}: ${value}`;
    }
  }
  return head;
}

export function parseResHead(head) {
  const headLines = head.split("\r\n");
  const [version, status, statusMessage] = headLines[0].split(" ");
  const headers = parseHeaders(headLines.slice(1));
  return { version, status, statusMessage, headers };
}

export function pipeHttpRequest(source, target, onHead) {
  let headBuffer;
  let headDone = false;
  source.on("data", (data) => {
    if (!headDone) {
      if (headBuffer) {
        headBuffer = Buffer.concat([headBuffer, data]);
      } else {
        headBuffer = data;
      }
      const bodySeparator = headBuffer.indexOf("\r\n\r\n");
      if (bodySeparator >= 0) {
        // +2 to include the last header CRLF.
        const bodyChunk = headBuffer.slice(bodySeparator);
        headBuffer = headBuffer.slice(0, bodySeparator);
        const newHead = onHead(headBuffer.toString("utf8"));
        
        headDone = true;
        target.write(Buffer.concat([Buffer.from(newHead), bodyChunk]));
      }
    } else {
      target.write(data);
    }
  });
  source.on("end", () => target.end());
}
