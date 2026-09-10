import pathlib
import subprocess
import tempfile
import unittest
from audit_public import inspect

class AuditTest(unittest.TestCase):
    def test_flags_content_without_returning_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            token = 'ghp_' + 'a' * 40
            (root / 'bad.txt').write_text(token)
            (root / 'safe.txt').write_text('https://example.com')
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            findings = inspect(root)
            self.assertEqual(findings, [('bad.txt', 'github-token')])
            self.assertNotIn(token, repr(findings))

if __name__ == '__main__':
    unittest.main()
