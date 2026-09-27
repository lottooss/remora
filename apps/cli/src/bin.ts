#!/usr/bin/env node
import { mainAsync } from './main.ts'

process.exitCode = await mainAsync(process.argv.slice(2))
