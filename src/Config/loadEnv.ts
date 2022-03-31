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
// @ts-ignore
{
    /**
     * An array of all valid environment variables
     * @constant
     * @type {string[]}
     */
    const envWhitelist: any[] = [
        'MONGO_URI',
        'REDIS_URI',
        'PORT',
        'HOST',
        'UNIX_SOCKET',
        'EMAIL_HOSTNAME',
        'ENABLE_CACHE',
        'ENABLE_IPFS',
        'LOAD_AUTO_PINNED_IPFS_FILES_ON_START',
        'CACHE_SIZE',
        'CACHE_MAX',
        'CACHE_EXPIRE_IN',
        'ENABLE_WEB_RESOLVER',
        'WEB_RESOLVER_PORT',
        'WEB_RESOLVER_HOST',
        'EXPRESS_SESSION_DRIVER',
        'WEB_RESOLVER_UNIX_SOCKET',
        'WEB_RESOLVER_SHARE_RPC_SERVER',
        'WEB_RESOLVER_AUTHENTICATE_REQUESTS',
        'WEB_RESOLVER_PROMPT_LOGIN',
        'SHORT_URL_SIZE',
        'ROOT_RESOLVER_BATCH_SIZE',
        'EXPRESS_SESSION_MAX_AGE',
        'EXPRESS_SESSION_SECRET',
        'EXPRESS_SESSION_SECRET_SIZE',
        'SERVICE_CLIENT_ID',
        'SERVICE_REDIRECT_URI',
        'ALLOW_CLIENT_OVERRIDE',
        'ALLOW_ROOT_USER_OVERRIDE',
        'ALLOW_UNAUTHORIZED_USER_OVERRIDE',
        'SERVICE_CLIENT_SECRET',
        'UNAUTHORIZED_USERNAME',
        'UNAUTHORIZED_GROUPS',
        'ROOT_USERNAME',
        'ROOT_PASSWORD',
        'ROOT_GROUPS',
        'LOG_LEVEL',
        'PLUGINS',
        'UPLOAD_TEMP_DIR'
    ];

    const noTransform: any[] = [

    ];

    function envToConfig(env: any) {
        let a = env.toLowerCase().split('_');
        let i = 1;
        while (i < a.length) {
            a[i] = a[i][0].toUpperCase() + a[i].substr(1);
            i++;
        }
        return a.join('');
    }

    const whitelist = envWhitelist.concat(envWhitelist.map(envToConfig));

    /**
     * Sets up nconf with the `env` store.
     * @param {Provider} nconf - Instance of `nconf.Provider`.
     * @returns {Provider} - Same instance of `nconf.Provider`.
     */
    function setupNconfEnv(nconf: any) {
        return nconf
            .env({
                whitelist,
                parseValues: true,
                transform: (obj: any) => {
                    if (envWhitelist.includes(obj.key) && !noTransform.includes(obj.key)) {
                        if (obj.key.indexOf('_') !== -1) {
                            obj.key = envToConfig(obj.key);
                        } else {
                            obj.key = obj.key.toLowerCase();
                        }

                        envWhitelist.push(obj.key);
                    }
                    return obj;
                }
            });
    };

    module.exports = setupNconfEnv;
}
