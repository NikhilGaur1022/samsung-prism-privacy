from qdrant_client import QdrantClient
from qdrant_client.models import Filter, HasIdCondition, SearchParams

qdrant_client = QdrantClient(url="http://localhost:6333")

def identify_speaker_within_room(extracted_voice_vector, pre_registered_muids: list[str]):
    """
    Searches for a voice match strictly within the pre-registered group of participants.
    
    pre_registered_muids: List of UUIDs gathered beforehand
    """
    scoped_filter = Filter(
        must=[
            HasIdCondition(has_id=pre_registered_muids)
        ]
    )
    
    results = qdrant_client.search(
        collection_name="user_voice_embeddings",
        query_vector=extracted_voice_vector,
        query_filter=scoped_filter,
        search_params=SearchParams(hnsw_ef=64),
        limit=1
    )
    
    if results and results[0].score >= 0.75:
        return results[0].payload["master_user_id"]
        
    return "UNKNOWN_BYSTANDER"