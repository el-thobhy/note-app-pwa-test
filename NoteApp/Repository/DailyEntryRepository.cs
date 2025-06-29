using Microsoft.Data.SqlClient;
using NoteApp.Models;
using System.Data;

namespace NoteApp.Repository
{
    public class DailyEntryRepository
    {
        private readonly SqlConnection _connection;
        private readonly SqlTransaction _transaction;

        public DailyEntryRepository(SqlConnection connection, SqlTransaction transaction)
        {
            _connection = connection;
            _transaction = transaction;
        }

        public void Insert(DailyEntry entry)
        {
            using var command = CreateCommand("insert");
            command.Parameters.AddWithValue("@Date", entry.Date);
            command.Parameters.AddWithValue("@Content", entry.Content);
            command.Parameters.AddWithValue("@Title_Note", entry.Title_Note);
            command.Parameters.AddWithValue("@UserId", entry.UserId);
            command.Parameters.AddWithValue("@NoteId", entry.NoteId);
            command.Parameters.AddWithValue("@Created_by", entry.Created_by ?? (object)DBNull.Value);

            command.ExecuteNonQuery();
        }

        public List<DailyEntry> GetByNoteId(int noteId)
        {
            using var command = CreateCommand("get_by_note_id");
            command.Parameters.AddWithValue("@NoteId", noteId);

            using var reader = command.ExecuteReader();
            List<DailyEntry> entries = new List<DailyEntry>();
            while (reader.Read())
            {
                entries.Add(MapEntry(reader));
            }
            return entries;
        }

        public DailyEntry? GetById(int id)
        {
            using var command = CreateCommand("get_by_entry_id");
            command.Parameters.AddWithValue("@Id", id);

            using var reader = command.ExecuteReader();
            if (reader.Read())
            {
                return MapEntry(reader);
            }
            return null;
        }

        public void Update(DailyEntry entry)
        {
            using var command = CreateCommand("update_entry");
            command.Parameters.AddWithValue("@Id", entry.Id);
            command.Parameters.AddWithValue("@Date", Convert.ToDateTime(entry.Date));
            command.Parameters.AddWithValue("@Content", entry.Content);
            command.Parameters.AddWithValue("@Title_Note", entry.Title_Note);
            command.Parameters.AddWithValue("@Modified_by", entry.Modified_by ?? (object)DBNull.Value);

            command.ExecuteNonQuery();
        }

        public void Delete(int id, string? deletedBy)
        {
            using var command = CreateCommand("delete");
            command.Parameters.AddWithValue("@Id", id);
            command.Parameters.AddWithValue("@Deleted_by", deletedBy ?? (object)DBNull.Value);

            command.ExecuteNonQuery();
        }

        private SqlCommand CreateCommand(string action)
        {
            var cmd = _connection.CreateCommand();
            cmd.Transaction = _transaction;
            cmd.CommandType = CommandType.StoredProcedure;
            cmd.CommandText = "uspNoteDailyEntries";
            cmd.Parameters.AddWithValue("@action", action);
            return cmd;
        }

        private DailyEntry MapEntry(SqlDataReader reader)
        {
            return new DailyEntry
            {
                Id = Convert.ToInt32(reader["Id"]),
                Date = reader["Date"] != DBNull.Value ? Convert.ToDateTime(reader["Date"]).ToString("yyyy-MM-dd"): "",
                Content = reader["Content"]?.ToString(),
                Title_Note = reader["Title_Note"]?.ToString(),
                UserId = reader["UserId"]?.ToString(),
                NoteId = Convert.ToInt32(reader["NoteId"]),
                Created_by = reader["Created_by"]?.ToString(),
                Created_on = reader["Created_on"] != DBNull.Value ? Convert.ToDateTime(reader["Created_on"].ToString()) : DateTime.Now,
                Modified_by = reader["Modified_by"]?.ToString(),
                Modified_on = reader["Modified_on"] as DateTime?,
                Deleted_by = reader["Deleted_by"]?.ToString(),
                Deleted_on = reader["Deleted_on"] as DateTime?,
                Is_delete = Convert.ToBoolean(reader["Is_delete"])
            };
        }
    }
}
