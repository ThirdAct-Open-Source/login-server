/**
 * This component is licensed separately from the main program
 * @module attic-server/ApplicationContext
 * @license LGPL-3.0
 * Copyright (C) 2021 Zachary R.T. Boyd <zachary@zacharyboyd.nyc>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 *  You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
import * as fs from 'fs-extra';
import * as path from 'path';
import { Provider } from 'nconf';
const yargs = <any>require('yargs');
import { default as DefaultConfig } from './DefaultConfig';
import { default as Config } from './Config';

let nconf: Provider&Config = (new Provider()) as any;
const pkg: any = JSON.parse(fs.readFileSync(__dirname+'/../../package.json', 'utf8')) ;

const overrides = {};

nconf.overrides(overrides);

let argvConfig =
    (<any>yargs)
        .version(pkg.version)
        .usage('Usage: attic-server')
        .options({
            f: {
                alias: 'file',
                describe: 'Path to a config file to use',
                demand: false
            }
        });

require('./loadEnv')(nconf);

nconf
    .argv(argvConfig);

let configFile = nconf.get('file');

if (configFile) {
    if (!fs.existsSync(configFile)) {
        console.error(`[global]: config file "${configFile}" does not exist. exiting.`);
        process.exit(1);
    }
    nconf.file('custom', { file: configFile });
} else {
    nconf.use('memory');
}

nconf.defaults(DefaultConfig);

const configHandler = {
    get: function (obj: any, prop: any) {
        const { nconf } = obj;

        if (prop === 'drivers') {
            return Array.from((global as any).ApplicationContext.drivers.keys());
        }

        if (prop === 'nconf' || prop === 'config')
            return nconf;


        if (prop in nconf)
            return nconf[prop];

        return nconf.get(prop);
    },
    set: function (obj: any, prop: any, value: any) {
        const { nconf } = obj;

        if (prop === 'drivers') {
            return false;
        }

        if (prop === 'nconf' || prop === 'config' || (prop in nconf))
            return;

        return nconf.set(prop, value);
    },
    has: function (obj: any, prop: any) {
        const { nconf } = obj;

        if (prop === 'drivers') {
            return true
        }

        return (prop === 'nconf' || prop === 'config' || (prop in nconf) || Boolean(nconf.get(prop)));
    },
    deleteProperty(obj: any, prop: any): boolean {
        const { nconf } = obj;

        if (prop === 'drivers') {
            return false;
        }

        if (prop === 'nconf' || prop === 'config' || (prop in nconf))
            return false;

        return nconf.set(prop, void(0));
    }
};

interface nconfHolder { nconf: Provider; }
export type ConfigType = Config&Provider&nconfHolder;
const config = <ConfigType>(new Proxy(<ConfigType>(<any>{ nconf }), configHandler));
export default config;