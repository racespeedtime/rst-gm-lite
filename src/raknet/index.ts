import { onIncomingPacket, onIncomingRPC, onOutgoingPacket, onOutgoingRPC } from "@infernus/raknet";

onIncomingPacket(({ next }) => {
  return next();
});

onOutgoingPacket(({ next }) => {
  return next();
});

onIncomingRPC(({ next }) => {
  return next();
});

onOutgoingRPC(({ next }) => {
  return next();
});

export {};
