import session from 'express-session';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import Config from "../Config";
import cookieParser from "cookie-parser";
import {redis, default as mongoose} from "../Database";

const MongoStore = require('connect-mongo');
export const RedisStore = require('connect-redis')(session)

if (!Config.expressSessionSecret) {
    try {
        let generatedSecret = crypto.randomBytes(Config.expressSessionSecretSize).toString('base64');
        fs.appendFileSync(path.join(__dirname, '..', '..', '.env'), `EXPRESS_SESSION_SECRET=${generatedSecret}\n`);
        Config.set('expressSessionSecret', generatedSecret);
    } catch (err) {
        console.error(`could not save a unique key for the expression secret to .env`);
    }
}

export const ExpressSessionStore = new RedisStore({ client: redis });
  // Config.expressSessionDriver === ExpressSessionDrivers.redis ?// : MongoStore.create({ client: mongoose.connection });

// @ts-ignore
export const SessionMiddleware = session({
    cookie: {
        maxAge: Config.expressSessionMaxAge
    },
    secret: Config.expressSessionSecret,
    store: ExpressSessionStore,
    resave: true,
    saveUninitialized: true
});

// @ts-ignore
export const CookieMiddleware = cookieParser(Config.expressSessionSecret);

export default SessionMiddleware;
