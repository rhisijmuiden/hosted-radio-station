"""FTP(S) server for the backup tests: ftp-server.py <dir> <port> <user> <password> [certfile]."""
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer

folder, port, user, password = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
cert = sys.argv[5] if len(sys.argv) > 5 else None
auth = DummyAuthorizer()
auth.add_user(user, password, folder, perm="elradfmwMT")
handler = TLS_FTPHandler if cert else FTPHandler
if cert:
    handler.certfile = cert
    handler.tls_control_required = True
    handler.tls_data_required = True
handler.authorizer = auth
handler.passive_ports = range(port + 1, port + 40)
FTPServer(("127.0.0.1", port), handler).serve_forever()
