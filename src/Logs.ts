/**
 * @author Etomon Team <open-source@etomon.com>
 * @copyright 2021 Etomon, PBC
 */
import {IApplicationContext} from "@znetstar/attic-common/lib/Server";

const winston = require('winston');
const {
    format: logFormat
} = winston;

export function createLogger(ctx: IApplicationContext) {
    const logger = (global as any).logger = winston.createLogger({
        format: logFormat.combine(
            logFormat((info: any) => {
                info.hostname = ctx.config.hostname;
                return info;
            })()
        ),
        transports: [
            new (winston.transports.Console)({
                format: logFormat.combine(
                    logFormat.json()
                ),
                level: 'silly'
            })
        ]
    });
    return logger;
}

