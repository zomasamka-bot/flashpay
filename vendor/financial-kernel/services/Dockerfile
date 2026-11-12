# Build context must be the extracted, verified kernel release + locked dependencies.
# No credentials, profiles, policy approvals or financial data enter the image.
FROM node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY dependencies /node_modules
COPY package /kernel
COPY package/services/container.cjs package/services/producer-scheduler.cjs package/services/producer-cycle.cjs package/services/phase-trace.cjs /tools/
USER 10001:10001
ENTRYPOINT []
CMD ["node", "/tools/container.cjs"]
