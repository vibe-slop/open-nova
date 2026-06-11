#!/usr/bin/env -S node --import tsx
/**
 * open-nova CLI — Steam Deck terminal friendly. Thin wrapper over @open-nova/core.
 *
 * Usage:
 *   open-nova detect
 *   open-nova decrypt <filelist.bin> [out]
 *   open-nova encrypt <filelist.bin> [out]
 *   open-nova unpack <filelist.bin> <white_img.bin> <outDir> --game=2
 *   open-nova mods <list|install|uninstall> [name] --game=2 [--base=<dir>]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GAMES,
  getGameById,
  getGameByNumber,
  findSteamRoot,
  parseLibraryFolders,
  findGameInstall,
  decryptFilelist,
  encryptFilelist,
  unpackArchive,
  ModManager,
  unpackTrb,
  unpackWpd,
  unpackImgb,
} from '@open-nova/core';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (const a of args) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) flags[m[1]] = m[2];
  else if (a.startsWith('--')) flags[a.slice(2)] = true;
  else pos.push(a);
}

const gameFromFlag = () => {
  const g = flags.game ?? '2';
  const byNum = getGameByNumber(Number(g));
  return byNum ?? getGameById(String(g));
};
const defaultBase = () => flags.base ?? path.join(os.homedir(), '.local', 'share', 'open-nova');

function die(msg) {
  console.error('error:', msg);
  process.exit(1);
}

const [cmd] = pos;

switch (cmd) {
  case 'detect': {
    const root = await findSteamRoot();
    console.log('Steam root:', root ?? '(not found)');
    if (root) {
      const libs = await parseLibraryFolders(root);
      console.log('Libraries:', libs.length);
      for (const g of GAMES) {
        const inst = await findGameInstall(g, root);
        console.log(`  ${g.id.padEnd(7)} ${g.steamAppId}  ${inst ?? '(not installed)'}`);
      }
    }
    break;
  }

  case 'decrypt': {
    const [, inPath, out] = pos;
    if (!inPath) die('usage: open-nova decrypt <filelist.bin> [out]');
    const buf = await fs.readFile(inPath);
    const r = decryptFilelist(buf);
    const outPath = out ?? inPath + '.dec';
    await fs.writeFile(outPath, r.data);
    console.log(`decrypted -> ${outPath} (checksum ${r.checksumOk ? 'OK' : 'MISMATCH'})`);
    break;
  }

  case 'encrypt': {
    const [, inPath, out] = pos;
    if (!inPath) die('usage: open-nova encrypt <filelist.bin> [out]');
    const buf = await fs.readFile(inPath);
    const outPath = out ?? inPath + '.enc';
    await fs.writeFile(outPath, Buffer.from(encryptFilelist(buf)));
    console.log(`encrypted -> ${outPath}`);
    break;
  }

  case 'unpack': {
    const [, filelist, img, outDir] = pos;
    const game = gameFromFlag();
    if (!filelist || !img || !outDir || !game) die('usage: open-nova unpack <filelist> <white_img> <outDir> --game=2');
    const { files } = unpackArchive(await fs.readFile(filelist), await fs.readFile(img), game.number);
    let i = 0;
    for (const f of files) {
      const rel = f.virtualPath === ' ' ? `noPath/FILE_${i}` : f.virtualPath;
      const dest = path.join(outDir, ...rel.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.data);
      i++;
    }
    console.log(`unpacked ${files.length} files -> ${outDir}`);
    break;
  }

  case 'textures': {
    const [, container, imgbPath, outDir] = pos;
    if (!container || !imgbPath || !outDir) die('usage: open-nova textures <container.trb|.wpd> <pixels.imgb> <outDir>');
    const cbuf = await fs.readFile(container);
    const imgb = await fs.readFile(imgbPath);
    const isWpd = cbuf.subarray(0, 3).toString('latin1') === 'WPD';
    const res = isWpd ? unpackWpd(cbuf) : unpackTrb(cbuf);
    const entries = res.entries ?? res.files ?? [];
    let count = 0;
    for (const e of entries) {
      if (!e.data) continue;
      const base = String(e.name).replace(/[\\/]/g, '_');
      for (const tex of unpackImgb(e.data, imgb, base)) {
        const dest = path.join(outDir, tex.fileName);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, tex.dds);
        count++;
      }
    }
    console.log(`extracted ${count} texture(s) -> ${outDir}`);
    break;
  }

  case 'mods': {
    const [, sub, name] = pos;
    const game = gameFromFlag();
    if (!game) die('unknown --game');
    const mm = new ModManager(defaultBase());
    const all = (await mm.listMods()).filter((m) => m.gameId === game.id);
    if (sub === 'list' || !sub) {
      if (all.length === 0) console.log(`no mods for ${game.id} (base ${defaultBase()})`);
      for (const m of all) console.log(`  [${m.installed ? 'x' : ' '}] ${m.name}  v${m.version}  by ${m.author}`);
    } else if (sub === 'install' || sub === 'uninstall') {
      if (!name) die(`usage: open-nova mods ${sub} <name> --game=2`);
      const m = all.find((x) => x.name === name || x.modName === name);
      if (!m) die(`mod not found: ${name}`);
      const install = await findGameInstall(game);
      if (!install) die('game install not found; pass --whitePath');
      const whitePath = flags.whitePath ?? path.join(install, game.dataRoot);
      if (sub === 'install') await mm.installMod(m.modName, whitePath, { data: true });
      else await mm.uninstallMod(m.modName, whitePath, { data: true });
      console.log(`${sub}ed ${m.name}`);
    } else {
      die(`unknown mods subcommand: ${sub}`);
    }
    break;
  }

  default:
    console.log(`open-nova — FFXIII trilogy archive/mod CLI

Commands:
  detect                                   find Steam + game installs
  decrypt <filelist> [out]                 decrypt a filelist index
  encrypt <filelist> [out]                 re-encrypt a filelist index
  unpack  <filelist> <white_img> <outDir>  extract an archive  (--game=1|2|3)
  textures <container> <pixels.imgb> <out>  extract textures (.trb/.wpd + .imgb) to DDS
  mods list                                list imported mods   (--game=2)
  mods install <name>                      install a mod        (--game=2)
  mods uninstall <name>                    uninstall a mod      (--game=2)

Flags: --game=1|2|3 (default 2)  --base=<dir>  --whitePath=<dir>`);
}
