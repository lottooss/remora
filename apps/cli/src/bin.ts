#!/usr/bin/env node
import { main } from './main.ts'

process.exitCode = main(process.argv.slice(2))
