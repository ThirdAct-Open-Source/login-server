import ApplicationContext from "./ApplicationContext";
import Config from "./Config";
import * as path from 'path';
import {IPlugin} from "@znetstar/attic-common/lib/Server/IPlugin";
import { Constructible } from "@znetstar/attic-common";
const npm = require('npm');
import {promisify} from "util";
import {PluginPath} from "@znetstar/attic-common/lib/Server";
import * as _ from 'lodash';


export const plugins = new Map<string, IPlugin>();
export default plugins;

let npmLoaded = false;

export async function loadPlugins(){
    await ApplicationContext.emitAsync('launch.loadPlugins.start');

    const installInstructions: { pluginModule: any, pluginPath: string, pluginName: string, pluginPathSpec: PluginPath, install: boolean }[] = [];

    for (let pluginPathSpec of Config.plugins) {
        ApplicationContext.logs.silly({
            method: `launch.loadPlugins.loadPlugin.scan.start`,
            params: [
                pluginPathSpec
            ]
        });
        let Plugin: Constructible<IPlugin>, pluginModule: any;

        let pluginPath: string, pluginName: string;
        if (typeof(pluginPathSpec) === 'string') {
            pluginPath = pluginPathSpec;
            pluginName = pluginPathSpec;
        } else {
            pluginName = pluginPathSpec[0];
            pluginPath = pluginPathSpec[1];
        }

        try {
            pluginModule = require(pluginPath);
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND')
                throw err;
        }

        const spec = {
          pluginPathSpec,
          install: !Boolean(pluginModule),
          pluginName,
          pluginPath,
          pluginModule: pluginModule
        };

        installInstructions.push(spec);
        ApplicationContext.logs.silly({
          method: `launch.loadPlugins.loadPlugin.scan.complete`,
          params: [
            pluginPathSpec,
            spec
          ]
        });
    }

    const pkg = await require('fs-extra').readJson(path.join(__dirname, '..', 'package.json'));
    const dependencies = Object.keys(pkg.dependencies);
    let installablePlugins = installInstructions.filter(i => (
      i.install && !Array.isArray(i.pluginPathSpec)
    ));
    const pluginsNotInPkg = installInstructions.filter(i => !dependencies.includes(i.pluginName) && !Array.isArray(i.pluginPathSpec));

    if (installablePlugins.length && pluginsNotInPkg.length) {
      installablePlugins = _.uniq(installablePlugins.concat(pluginsNotInPkg));
    }

  ApplicationContext.logs.debug({
    method: `launch.loadPlugins.loadPlugins.load.start`,
    params: [
      installInstructions.map((i) => ({
        ...i,
        pluginModule: !!i.pluginModule
      }))
    ]
  });

  for (const spec of installInstructions) {

    let { pluginName, pluginPath, pluginPathSpec, pluginModule } = spec;
    if (installablePlugins.length) {
      if (!npmLoaded) {
        await new Promise<void>((resolve, reject) => {
          npm.load((err: any) => {
            if (err) reject(err);
            else resolve();
          })
        });
        let cfg: any = {
          ...(Config.npmOptions || {}),
          save: false,
          loglevel: 'warn'
        };
        for (let k in cfg) {
          npm.config.set(k, cfg[k]);
        }

        npmLoaded = true;
      }
      ApplicationContext.logs.silly({
        method: `launch.loadPlugins.loadPlugin.npmInstall.start`,
        params: [
          installablePlugins
        ]
      });
      await new Promise<void>((resolve, reject) => npm.commands.install([...(installablePlugins.map(i => i.pluginName))], (err: any) => err ? reject(err) : resolve()));
      ApplicationContext.logs.silly({
        method: `launch.loadPlugins.loadPlugin.npmInstall.complete`,
        params: [
          installablePlugins
        ]
      });

    }
    let Plugin: Constructible<IPlugin>;

      ApplicationContext.logs.silly({
        method: `launch.loadPlugins.loadPlugin.load.start`,
        params: [
          pluginPathSpec,
          spec
        ]
      });

      if (!pluginModule) {
        try {
          pluginModule = require(pluginPath);
        } catch (err) {
          if (err.code !== 'MODULE_NOT_FOUND')
            throw err;
        }

        if (!pluginModule) {
          for (const possiblePaths of [
            [ `lib`, `Atticfile.js` ],
            [ `src`, `Atticfile.ts` ]
          ]) {
            const fullpath = path.join(pluginPath, ...possiblePaths);
            try {
              pluginModule = require(fullpath);
            } catch (err) {
              if (err.code !== 'MODULE_NOT_FOUND')
                throw err;
            }
          }
        }

        if (!pluginModule) {
          throw new Error(`Could not find plugin ${pluginName} or ${pluginPath}`);
        }

        ApplicationContext.logs.silly({
          method: `launch.loadPlugins.loadPlugin.npmInstall.complete`,
          params: [
            pluginPathSpec,
            spec
          ]
        });
      }

      if (pluginModule && pluginModule.default) {
        pluginModule = pluginModule.default;
      }

      Plugin = pluginModule;

      // @ts-ignore
      const plugin = new Plugin(ApplicationContext);

      await plugin.init();
      plugins.set(plugin.name, plugin);

      ApplicationContext.logs.silly({
        method: `launch.loadPlugins.loadPlugin.load.complete`,
        params: [
          pluginPathSpec,
          spec
        ]
      });

      await ApplicationContext.emitAsync(`Plugins.${plugin.name}.init`, plugin);
    }

  ApplicationContext.logs.debug({
    method: `launch.loadPlugins.loadPlugins.load.complete`,
    params: [
      installInstructions.map((i) => ({
        ...i,
        pluginModule: !!i.pluginModule
      }))
    ]
  });
    await ApplicationContext.emitAsync('launch.loadPlugins.complete');
}
