#!/usr/bin/env node
/**
 * scenes.json の Scene 定義を RAiM-FewShot-dev へ反映する CloudShell 用スクリプト。
 *
 * 使い方（CloudShell で、このフォルダに入って実行する）
 *
 *   cd ..   # raim_test で入れる（generate_scene_centroids.js と共用）
 *   npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-bedrock-runtime
 *   cd fewshot
 *   node apply_fewshot.js            # 確認だけ（AWS には何もしない）
 *   node apply_fewshot.js --apply    # バックアップを取ってから反映する
 *
 * 書き換える属性
 *   description / embedding_text / default_emotions / target_emotion /
 *   few_shots（bright 用）/ few_shots_downer（downer 用）
 *
 * textCentroid には触れない（UpdateItem の SET なので残る）。
 * 新しい Scene と embedding_text を変えた Scene は、このあと
 * generate_scene_centroids.js で textCentroid を作り直す必要がある。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TABLE = process.env.SCENE_TABLE_NAME || 'RAiM-FewShot-dev';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

const EMOTIONS = new Set([
  'neutral', 'happy', 'sad', 'angry', 'surprised', 'caring',
  'embarrassed', 'excited', 'curious', 'amused', 'thoughtful', 'playful',
]);

function loadScenes() {
  const file = path.join(__dirname, 'scenes.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).scenes;
}

// 反映前に中身を確かめる。間違った感情キーが入ると Lambda 側で捨てられるため。
function validate(scenes) {
  const errors = [];
  const ids = new Set();

  for (const scene of scenes) {
    if (!scene.id) errors.push('id がない Scene がある');
    if (ids.has(scene.id)) errors.push(`id が重複: ${scene.id}`);
    ids.add(scene.id);

    if (!scene.embedding_text) errors.push(`${scene.id}: embedding_text が空`);
    if (scene.target && !EMOTIONS.has(scene.target)) {
      errors.push(`${scene.id}: target が不明な感情 ${scene.target}`);
    }

    for (const shot of scene.shots || []) {
      for (const persona of ['bright', 'downer']) {
        const example = shot[persona];
        if (!example || !example.raim) {
          errors.push(`${scene.id}: 「${shot.user}」の ${persona} が空`);
          continue;
        }
        for (const key of Object.keys(example.emotions || {})) {
          if (!EMOTIONS.has(key)) errors.push(`${scene.id}: 不明な感情キー ${key}`);
        }
      }
    }
  }

  return errors;
}

function toItemFields(scene) {
  const shots = scene.shots || [];
  return {
    description: scene.description || '',
    embedding_text: scene.embedding_text,
    default_emotions: scene.default_emotions || {},
    target_emotion: scene.target || '',
    few_shots: shots.map((shot) => ({
      user: shot.user,
      raim: shot.bright.raim,
      emotions: shot.bright.emotions,
    })),
    few_shots_downer: shots.map((shot) => ({
      user: shot.user,
      raim: shot.downer.raim,
      emotions: shot.downer.emotions,
      ...(typeof shot.downer.overall_intensity === 'number'
        ? { overall_intensity: shot.downer.overall_intensity }
        : {}),
    })),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const scenes = loadScenes();
  const errors = validate(scenes);

  if (errors.length > 0) {
    console.error('scenes.json に問題があります:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(`${scenes.length} Scene（${apply ? '反映する' : '確認だけ'}）`);
  for (const scene of scenes) {
    console.log(`  ${scene.id.padEnd(10)} ${(scene.target || '-').padEnd(12)} ${scene.shots.length}組`);
  }

  if (!apply) {
    console.log('\n反映するには --apply を付けて実行してください。');
    return;
  }

  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  // バックアップ（textCentroid は重いので除く）
  const backup = [];
  let startKey;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'id, description, embedding_text, default_emotions, few_shots, few_shots_downer',
      ExclusiveStartKey: startKey,
    }));
    backup.push(...(page.Items || []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const backupFile = path.join(__dirname, `fewshot_backup_${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`\nバックアップ: ${backupFile}（${backup.length}件）`);

  const existing = new Map(backup.map((item) => [item.id, item]));
  const needCentroid = [];

  for (const scene of scenes) {
    const fields = toItemFields(scene);
    const names = {};
    const values = {};
    const sets = Object.keys(fields).map((key, index) => {
      names[`#k${index}`] = key;
      values[`:v${index}`] = fields[key];
      return `#k${index} = :v${index}`;
    });

    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id: scene.id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));

    const before = existing.get(scene.id);
    const isNew = !before;
    const textChanged = before && before.embedding_text !== scene.embedding_text;
    if (isNew || textChanged) needCentroid.push(scene.id);

    console.log(`  updated: ${scene.id}${isNew ? '（新規）' : ''}${textChanged ? '（embedding_text 変更）' : ''}`);
  }

  if (needCentroid.length > 0) {
    const args = needCentroid.map((id) => `--scene-id ${id}`).join(' ');
    console.log('\ntextCentroid を作り直す必要がある Scene があります。次を実行してください:');
    console.log(`  node ../generate_scene_centroids.js --apply --force ${args}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
