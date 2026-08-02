import { logger } from "@/logger";
import { GameMode } from "@infernus/core";

GameMode.onInit(({ next }) => {
  logger.info("Hello World!");
  return next();
});
