// 셋업 화면(정적 파일)을 dist/setup 으로. tsc 는 .html/.css/.js 를 옮기지 않습니다.
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/setup', { recursive: true })
cpSync('src/setup', 'dist/setup', { recursive: true })
console.log('setup → dist/setup')
