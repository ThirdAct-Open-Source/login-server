FROM ubuntu:20.04

WORKDIR /opt/login-server

ADD ./package.json /opt/login-server/package.json
ADD ./package-lock.json /opt/login-server/package-lock.json

RUN apt-get update -y && \
    apt-get install -y curl && \
    bash -c 'curl -fsSL https://deb.nodesource.com/setup_14.x | bash -' && \
    apt-get install -y nodejs build-essential python2 python3 && \
    ln -sv /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/* && \
    npm ci

ADD . /opt/login-server

RUN npm run build


RUN ln -s /opt/login-server/bin/login-server /usr/local/bin/login-server

ENV PATH "/usr/local/bin:/opt/login-server/bin:$PATH"

ENV UPLOAD_TEMP_DIR /tmp/attic/uploads

VOLUME /root/.jsipfs

EXPOSE 7373

ENTRYPOINT [ "/usr/local/bin/login-server" ]
