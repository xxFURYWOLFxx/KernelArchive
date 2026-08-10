FROM rust:1.84-alpine AS builder
WORKDIR /src
COPY . .
RUN cargo build --release

FROM alpine:3.21
COPY --from=builder /src/target/release/kernelarchive-binary-analyzer /usr/local/bin/kernelarchive-binary-analyzer
ENTRYPOINT ["kernelarchive-binary-analyzer"]

