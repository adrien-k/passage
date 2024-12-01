import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

import { createCertServer } from "./certs.js";
import { defaultLogger } from "./logger.js";
import { onHostToRelayMessage, OPEN_COULOIR, JOIN_COULOIR } from "./protocol.js";

const HOST_MATCH = /\r\nHost: (.+)\r\n/;
const TYPE_HOST = "host";
const TYPE_CLIENT = "client";

export default function relay({
  port,
  domain,
  http = false,
  email = "test@example.com",
  certsDirectory = "~/.couloir.certs",
  log = defaultLogger,
}) {
  let couloirCounter = 0;

  const hosts = {};
  const clients = {};
  const keyToHost = {};

  let socketCounter = 0;

  const createRelayServers = (onSocket) => {
    if (!http) {
      const certService = createCertServer({
        certsDirectory,
        log,
        email,
        domain,
      });
      return {
        relay: tls.createServer({ SNICallback: certService.SNICallback }, onSocket),
        certService,
      };
    } else {
      return { relay: net.createServer(onSocket) };
    }
  };

  function closeCouloirIfEmpty(host) {
    if (hosts[host].length > 0) {
      return;
    }

    log(`Closing couloir host ${host}`);
    delete hosts[host];
    delete clients[host];
    for (const key of Object.keys(keyToHost)) {
      if (keyToHost[key] === host) {
        delete keyToHost[key];
      }
    }
  }

  function bindNextSockets(host) {
    const pendingHosts = hosts[host].filter(({ busy }) => !busy);

    log(`Binding sockets clients:${clients[host].length}, hosts: ${pendingHosts.length}`);
    while (clients[host].length && pendingHosts.length) {
      const clientSocket = clients[host].shift();
      // We keep the host in place while it is busy to avoid closing a couloir that may look empty.
      const hostSocket = pendingHosts[0];
      clientSocket.busy = hostSocket.busy = true;
      clientSocket.socket.pipe(hostSocket.socket);
      // Write the data that has already been consumed
      hostSocket.socket.write(clientSocket.requestBuffer);
      hostSocket.socket.pipe(clientSocket.socket);
      bindNextSockets(host);
    }
  }

  const { relay, certService } = createRelayServers((socket) => {
    const id = socketCounter++;

    // A Relay socket can be either a regular client HTTP requestChunks or a host proxy socket.
    // They are stored in either `hosts` or `clients` hashes respectively and pulled by bindNextSockets
    const relaySocket = {
      id,
      socket,
      // Null until we identify which couloir host this socket belongs to.
      host: null,
      // In case some data is already read from the client socket before piping to the host
      // we keep it aside to write it first.
      requestBuffer: Buffer.from([]),
      // Flagged as a regular client socket until it proves to be the host communicating.
      type: TYPE_CLIENT,
      // True as soon as the socket is used for relaying
      busy: false,
    };

    function onCouloirOpen(host, sendResponse) {
      relaySocket.type = TYPE_HOST;

      if (!host.endsWith(`.${domain}`)) {
        host = `couloir${couloirCounter > 1 ? couloirCounter : ""}.${domain}`;
      }

      if (hosts[host]) {
        return sendResponse({
          error: `Couloir host ${host} is already opened`,
        });
      }

      couloirCounter++;
      const key = crypto.randomBytes(24).toString("hex");
      log(`New couloir host ${host} opened by #${relaySocket.id}`, "info");

      if (certService) {
        // Already start the let's encrypt cert generation.
        // We don't await it on purpose
        certService.getCertOnDemand(host);
      }

      relaySocket.host = host;
      keyToHost[key] = host;
      hosts[host] = [];
      clients[host] = [];

      sendResponse({ key, host });
    }

    function onCouloirJoin(key, sendResponse) {
      relaySocket.type = TYPE_HOST;
      const host = keyToHost[key];

      if (host) {
        relaySocket.host = host;
        hosts[host].push(relaySocket);
        log(`Socket (host) connected ${host}#${relaySocket.id}`);
        sendResponse({});
        bindNextSockets(host);
      } else {
        sendResponse({
          error: "Invalid couloir key. Please restart your couloir client.",
        });
      }
    }

    onHostToRelayMessage(socket, log, {
      [OPEN_COULOIR]: onCouloirOpen,
      [JOIN_COULOIR]: onCouloirJoin,
    });

    const onSocketClientData = (data) => {
      if (relaySocket.type === TYPE_HOST) {
        return socket.off("data", onSocketClientData);
      }

      relaySocket.requestBuffer = Buffer.concat([relaySocket.requestBuffer, data]);
      const headLastByte = relaySocket.requestBuffer.indexOf("\r\n\r\n");

      // Wait for the end of head
      if (headLastByte === -1) {
        return;
      }

      const head = relaySocket.requestBuffer.subarray(0, headLastByte + 2).toString();
      const host_match = head.match(HOST_MATCH);
      // This removes the potential port that is part of the Host but not of how couloirs
      // are identified.
      const host = host_match && host_match[1].replace(/:.*$/, "");
      if (host && hosts[host]) {
        relaySocket.host = host;
        clients[host].push(relaySocket);
        log(`Client socket ${host}#${relaySocket.id} connected (${clients[host].length})`);

        bindNextSockets(host);

        // No need to look further in socket stream
        socket.off("data", onSocketClientData);
      } else {
        socket.write("HTTP/1.1 404 Not found\r\n\r\nNot found");
        socket.end();
      }
    };

    socket.on("data", onSocketClientData);

    socket.on("end", () => {
      log(`Socket (${relaySocket.type}) disconnected ${relaySocket.host}#${relaySocket.id}`);

      const host = relaySocket.host;
      if (host && relaySocket.type === TYPE_HOST && hosts[host]) {
        // Ensure we don't leave a dead socket in the available hosts
        hosts[host] = hosts[host].filter(({ id }) => id !== relaySocket.id);
        closeCouloirIfEmpty(host);
      }
    });

    socket.on("error", (err) => {
      log(err, "error");
    });
  });

  return {
    on: relay.on.bind(relay),
    start: async () => {
      if (certService) {
        // Already prepare a few certs cert for the main domain and first couloir
        // We don't wait for those requests to complete
        certService.getCertOnDemand(domain);
        certService.getCertOnDemand(`couloir.${domain}`);

        await certService.start();
      }

      await new Promise((resolve, reject) => {
        relay.on("error", reject);
        relay.listen(port, () => {
          log(`Relay server started on port ${port}`, "info");
          resolve();
        });
      });
    },
    stop: async () => {
      await certService?.stop();
      await new Promise((resolve) => {
        relay.close(resolve);
      });
    },
  };
}
