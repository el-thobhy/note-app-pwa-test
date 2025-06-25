using Microsoft.Data.SqlClient;
using NoteApp.Models;
using System.Data;

namespace NoteApp.Repository
{
    public class NoteRepository
    {
        private readonly SqlConnection _connection;
        private readonly SqlTransaction _transaction;

        public NoteRepository(SqlConnection connection, SqlTransaction transaction)
        {
            _connection = connection;
            _transaction = transaction;
        }

        public void Insert(Note note)
        {
            using var command = CreateCommand("insert");
            command.Parameters.AddWithValue("@Title", note.Title);
            command.Parameters.AddWithValue("@UserId", note.UserId);
            command.Parameters.AddWithValue("@Created_by", note.Created_by ?? (object)DBNull.Value);

            command.ExecuteNonQuery();
        }

        public List<Note> GetAll()
        {
            using var command = CreateCommand("get_all");

            using var reader = command.ExecuteReader();
            List<Note> result = new List<Note>();
            while (reader.Read())
            {
                result.Add(MapNote(reader));
            }
            return result;
        }

        public Note? GetById(int id)
        {
            using var command = CreateCommand("get_by_id");
            command.Parameters.AddWithValue("@Id", id);

            using var reader = command.ExecuteReader();
            if (reader.Read())
            {
                return MapNote(reader);
            }
            return null;
        }

        public void Update(Note note)
        {
            using var command = CreateCommand("update_note");
            command.Parameters.AddWithValue("@Id", note.Id);
            command.Parameters.AddWithValue("@Title", note.Title);
            command.Parameters.AddWithValue("@Modified_by", note.Modified_by ?? (object)DBNull.Value);

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
            cmd.CommandText = "uspNote";
            cmd.Parameters.AddWithValue("@action", action);
            return cmd;
        }

        private Note MapNote(SqlDataReader reader)
        {
            return new Note
            {
                Id = reader["Id"] .ToString(),
                Title = reader["Title"] as string,
                UserId = reader["UserId"] as string,
                Created_by = reader["Created_by"] as string,
                Created_on = Convert.ToDateTime(reader["Created_on"] as string),
                Modified_by = reader["Modified_by"] as string,
                Modified_on = Convert.ToDateTime(reader["Modified_on"] as string),
                Deleted_by = reader["Deleted_by"] as string,
                Deleted_on = Convert.ToDateTime(reader["Deleted_on"] as string),
                Is_delete = reader["Is_delete"].ToString() == "0" ? false: true
            };
        }


    }
}
