# Third-party notices

## AppWorld evaluation adapter

`benchmarks/appworld/` independently adapts the public APIs of [StonyBrookNLP/appworld](https://github.com/StonyBrookNLP/appworld), reference commit `42b5bcf3cd334fee33f0c37c02070a9f5807add5`. AppWorld's core package is Apache-2.0; its application/task bundles have separate accompanying terms and sharing restrictions. Local installations and unpacked data live in ignored runtime directories and are not redistributed with this adapter. Preserve upstream notices; do not publish unpacked task solutions or private evaluation assertions.

## DeepSeek Harness tool-call scheduler

`src/adapters/deepseek-harness-tool-calls.ts` is a scoped TypeScript port of the tool-call scheduling behavior in `deepseek-ai/deepseek-harness`, revision `47f943859bef60e4160492346772ded9b24f765a`, specifically `packages/core/agent-loop/src/tool-calls.ts`. It adapts the scheduler to microDSH's `ModelToolCall`, `ToolRuntime`, and `ResultEnvelope` interfaces. This does not include the upstream Cordis/Fiber runtime or other upstream packages.

Copyright (c) 2026 DeepSeek

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
