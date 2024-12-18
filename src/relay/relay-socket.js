import { COULOIR_STREAM, COULOIR_OPEN, COULOIR_JOIN } from "../protocol.js";
import { htmlResponse, HttpRequest } from "../http.js";

import CouloirClientSocket from "../couloir-client-socket.js";
import { TYPE_CLIENT, TYPE_HOST } from "./relay-couloir.js";
import logo from "../logo.js";

export default class RelaySocket extends CouloirClientSocket {
  constructor(relay, socket) {
    super(socket);

    this.relay = relay;

    this.ip = socket.remoteAddress;
    // Null until we identify which couloir host this socket belongs to.
    this.host = null;
    // Host or Client socket
    this.type = null;
    // True as soon as the socket is used for relaying
    this.bound = false;

    this.#listen();
  }

  log(message, level) {
    let prefix = "";
    prefix += this.relay.verbose ? `[${this.ip}] ` : "";
    prefix += this.relay.verbose ? `[#${this.id}] ` : "";
    prefix += this.type ? `[${this.type}] ` : "";
    prefix += this.host ? `[${this.host}] ` : "";
    this.relay.log(`${prefix}${message}`, level);
  }

  proxy(hostSocket) {
    this.bound = hostSocket.bound = true;
    hostSocket.couloirProtocol.sendMessage(COULOIR_STREAM, null, { skipResponse: true });
    // We pipe the stream transformers as we are sure that:
    // - they retain protocol-level information.
    // - their data has not been consumed yet.
    hostSocket.stream.pipe(this.socket);
    // Pipe the current request and everything else that flows through the socket.
    this.req.pipe(hostSocket.socket);
    this.socket.on("end", () => {
      hostSocket.socket.end();
    })
  }

  async end({ force = false } = {}) {
    if (!this.bound || force) {
      await new Promise((r) => {
        this.socket.end(r);
      });
    }
  }

  async #listen() {
    this.couloirProtocol.onMessage(COULOIR_OPEN, (payload) => {
      this.type = TYPE_HOST;
      try {
        const couloir = this.relay.openCouloir(payload);
        this.host = couloir.host;
        return { key: couloir.key, host: couloir.host };
      } catch (e) {
        return { error: e.message };
      }
    });

    this.couloirProtocol.onMessage(COULOIR_JOIN, ({key}, sendResponse) => {
      const couloir = this.relay.getCouloir(key);

      if (couloir) {
        // Send the ACK already to ensure it goes out before the stream starts
        sendResponse();
        couloir.addHostSocket(this);
      } else {
        return { error: "Invalid couloir key. Please restart your couloir client." };
      }
    });

    if (!await this.couloirProtocol.isCouloir) {
      this.type = TYPE_CLIENT;
      try {
        const req = await HttpRequest.nextOnSocket(this.stream);
        this.req = req;

        // This removes the potential port that is part of the Host but not of how couloirs
        // are identified.
        const host = req.headers["Host"]?.[0]?.replace(/:.*$/, "");
        if (host && host === this.relay.domain) {
          this.socket.write(
            htmlResponse(
              req.headers,
              logo(`\n\n  To open a new couloir, run:\n  > ${this.relay.exposeCommand()}`, { center: false })
            )
          );
          this.socket.end();
          return;
        }
        if (host && this.relay.couloirs[host]) {
          this.relay.couloirs[host].addClientSocket(this);
        } else {
          this.socket.write(
            htmlResponse(
              req.headers,
              logo(`404 - Couloir "${host}" is not open`),
              {
                status: "404 Not found",
              }
            )
          );
          this.socket.end();
        }
      } catch (e) {
        if (e.code === "INVALID_PROTOCOL") {
          this.socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${e.message}.`);
          this.socket.end();
          return;
        }

        if (e === "EARLY_SOCKET_CLOSED") {
          // This is fine too, did not receive any request and socket got closed.
          return;
        }

        throw e;
      }
    }
  }
}
