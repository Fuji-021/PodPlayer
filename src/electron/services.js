import clc from 'cli-color';
import checkAuthToken from '../utils/checkAuthToken';
import server from '@neteaseapireborn/api/server';

export async function startNeteaseMusicApi() {
  // Let user know that the service is starting
  console.log(`${clc.redBright('[NetEase API]')} initiating NCM API`);

  // Load the NCM API.
  await server.serveNcmApi({
    port: 10766, // [DEV BUILD] 10755→10766，避开 dev-serve / 正式版的 NCM API 端口冲突
    moduleDefs: require('../ncmModDef'),
  });
}
