from sqlalchemy import Column, Integer, Float, DateTime
from sqlalchemy.orm import declarative_base
import datetime

Base = declarative_base()

class SystemHistory(Base):
    __tablename__ = "system_history"
    id = Column(Integer, primary_key=True, index=True)
    cpu_usage = Column(Float)
    memory_usage = Column(Float)
    gpu_usage = Column(Float, nullable=True)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)