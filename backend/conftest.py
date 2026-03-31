import sys
import os

# Add backend/ and backend/tests/ to sys.path for test imports
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tests'))
