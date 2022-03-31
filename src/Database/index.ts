import { connect, Mongoose } from 'mongoose';
import config from '../Config';
import ApplicationContext from "../ApplicationContext";
import Redis from 'ioredis';
import {RPCServer} from "../RPC";

const mongoose = (<any>global).mongoose = <Mongoose>(<any>require('mongoose'));
mongoose.connect(config.mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: true,
  useCreateIndex: true
})
.then(() => {
  return ApplicationContext.triggerHook(`Database.connected`);
})
.catch((err: Error) => {
    console.error(`Error connecting to mongoose: ${err.stack}`);
    process.exit(1);
});

// @ts-ignore
export const redis = new Redis(config.redisUri);

RPCServer.methods.redisFlushAll = async () => { await redis.flushall(); }

export async function loadModels() {
    await ApplicationContext.emitAsync('launch.loadModels.start');
    require('../Event');
    require('../User');
    require('../Auth/Client');
    require('../Auth/AccessToken');
    require('../Entities/IdentityEntity');
    require('../Entity');
    require('../Entities/HTTPResourceEntity');
    await ApplicationContext.emitAsync('launch.loadModels.complete');

}


export default mongoose;
