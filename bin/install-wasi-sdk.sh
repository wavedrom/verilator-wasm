#!/usr/bin/bash
export WASI_VERSION=33
wget https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VERSION}/wasi-sdk-${WASI_VERSION}.0-x86_64-linux.tar.gz
tar -xzf wasi-sdk-${WASI_VERSION}.0-x86_64-linux.tar.gz
sudo mv wasi-sdk-${WASI_VERSION}.0-x86_64-linux /opt/wasi-sdk
