import clc from 'cli-color';
import checkAuthToken from '../utils/checkAuthToken';
import server from '@neteaseapireborn/api/server';

// [事故根治·实例隔离] 端口改为入参（由 background.js 按 PODPLAYER_PROFILE 传入），
//   保证多实例各用各的网易云 API 端口、不再 EADDRINUSE。默认 10754=正式版。
export async function startNeteaseMusicApi(port = 10754) {
  // Let user know that the service is starting
  console.log(
    `${clc.redBright('[NetEase API]')} initiating NCM API on :${port}`
  );

  // Load the NCM API.
  await server.serveNcmApi({
    port,
    moduleDefs: require('../ncmModDef'),
  });
}
