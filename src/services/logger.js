import pino from "pino";
import PinoPretty from "pino-pretty";

const logger = pino(PinoPretty({ translateTime: "SYS:standard", colorize: true }));

export default logger;